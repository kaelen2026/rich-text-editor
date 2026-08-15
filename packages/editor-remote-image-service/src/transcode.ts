export const MAX_REMOTE_IMAGE_BYTES = 10 * 1024 * 1024;
export const REMOTE_IMAGE_TIMEOUT_MS = 5_000;
const MAX_REDIRECTS = 3;

export interface RemoteImageResponse {
  status: number;
  headers: Pick<Headers, "get">;
  body: AsyncIterable<Uint8Array>;
}

/** Server integrations supply their own DNS, HTTP client, and durable storage. */
export interface RemoteImageServices {
  resolve(hostname: string, signal: AbortSignal): Promise<readonly string[]>;
  fetch(url: URL, signal: AbortSignal): Promise<RemoteImageResponse>;
  store(bytes: Uint8Array, contentType: RemoteImageContentType): Promise<{ url: string }>;
}

export type RemoteImageContentType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type RemoteImagePolicyCode =
  | "invalid-url"
  | "private-address"
  | "redirect-limit"
  | "timeout"
  | "too-large"
  | "invalid-image";

export class RemoteImagePolicyError extends Error {
  constructor(
    readonly code: RemoteImagePolicyCode,
    message: string,
  ) {
    super(message);
    this.name = "RemoteImagePolicyError";
  }
}

/**
 * Server-side remote-image ingestion. It intentionally never returns the source URL: a successful
 * result is an object-store URL, while every unsafe or unverifiable source is rejected.
 */
export async function transcodeRemoteImage(
  source: string,
  services: RemoteImageServices,
): Promise<{ url: string }> {
  let url = parseRemoteURL(source);
  const signal = AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      await assertPublicHost(url, services, signal);
      const response = await services.fetch(url, signal);
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new RemoteImagePolicyError("invalid-image", "图片重定向缺少目标地址");
        }
        if (redirects === MAX_REDIRECTS) {
          throw new RemoteImagePolicyError("redirect-limit", "图片重定向次数超过上限");
        }
        url = parseRemoteURL(new URL(location, url).href);
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        throw new RemoteImagePolicyError("invalid-image", `图片服务返回 HTTP ${response.status}`);
      }
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_IMAGE_BYTES) {
        throw new RemoteImagePolicyError("too-large", "图片超过 10MB");
      }
      const bytes = await readBounded(response.body, signal);
      const contentType = sniffImage(bytes);
      const declaredType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
      if (!contentType || !declaredType?.startsWith("image/")) {
        throw new RemoteImagePolicyError("invalid-image", "响应不是可验证的图片");
      }
      return services.store(bytes, contentType);
    }
  } catch (error) {
    if (signal.aborted && !(error instanceof RemoteImagePolicyError)) {
      throw new RemoteImagePolicyError("timeout", "图片转存超过 5 秒");
    }
    throw error;
  }
  throw new RemoteImagePolicyError("redirect-limit", "图片重定向次数超过上限");
}

function parseRemoteURL(value: string): URL {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      !url.hostname
    ) {
      throw new Error();
    }
    return url;
  } catch {
    throw new RemoteImagePolicyError("invalid-url", "图片地址只支持 http/https URL");
  }
}

async function assertPublicHost(
  url: URL,
  services: RemoteImageServices,
  signal: AbortSignal,
): Promise<void> {
  const addresses = await services.resolve(url.hostname, signal);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new RemoteImagePolicyError("private-address", "图片地址不能解析到私有或本地网络");
  }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::" || normalized.startsWith("fe80:")) {
    return true;
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }
  if (normalized.startsWith("::ffff:")) {
    return isPrivateAddress(normalized.slice("::ffff:".length));
  }
  const octets = normalized.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function readBounded(
  body: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    if (signal.aborted) {
      throw new DOMException("超时", "TimeoutError");
    }
    size += chunk.byteLength;
    if (size > MAX_REMOTE_IMAGE_BYTES) {
      throw new RemoteImagePolicyError("too-large", "图片超过 10MB");
    }
    chunks.push(chunk);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function sniffImage(bytes: Uint8Array): RemoteImageContentType | undefined {
  if (matches(bytes, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (matches(bytes, [255, 216, 255])) return "image/jpeg";
  if (
    new TextDecoder().decode(bytes.slice(0, 6)) === "GIF87a" ||
    new TextDecoder().decode(bytes.slice(0, 6)) === "GIF89a"
  )
    return "image/gif";
  if (
    new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
  )
    return "image/webp";
  return undefined;
}

function matches(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value);
}
