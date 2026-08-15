import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import {
  type RemoteImageContentType,
  RemoteImagePolicyError,
  transcodeRemoteImage,
} from "@kaelen/editor-remote-image-service";

const port = Number(process.env.PORT ?? 4174);
const assetDirectory = process.env.REMOTE_IMAGE_ASSET_DIR ?? ".demo-assets";
const publicBaseURL = process.env.REMOTE_IMAGE_PUBLIC_BASE_URL ?? `http://localhost:${port}/assets`;

const server = createServer(async (request, response) => {
  if (request.method === "POST" && request.url === "/remote-images") {
    await handleTransfer(request, response);
    return;
  }
  if (request.method === "GET" && request.url?.startsWith("/assets/")) {
    await serveAsset(request.url.slice("/assets/".length), response);
    return;
  }
  response.writeHead(404).end();
});

server.listen(port, () => {
  console.log(`Remote image demo service listening on http://localhost:${port}`);
});

async function handleTransfer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const input = await readJSON(request);
    const asset = await transcodeRemoteImage(input.url, {
      resolve: async (hostname, signal) => {
        if (signal.aborted) throw new DOMException("超时", "TimeoutError");
        return (await lookup(hostname, { all: true, verbatim: true })).map(
          (entry) => entry.address,
        );
      },
      fetch: async (url, signal) => {
        const result = await fetch(url, { redirect: "manual", signal });
        return { status: result.status, headers: result.headers, body: responseBody(result) };
      },
      store: async (bytes, contentType) => storeAsset(bytes, contentType),
    });
    json(response, 201, asset);
  } catch (error) {
    const status = error instanceof RemoteImagePolicyError ? 422 : 400;
    json(response, status, {
      error: error instanceof Error ? error.message : "无效的转存请求",
      ...(error instanceof RemoteImagePolicyError ? { code: error.code } : {}),
    });
  }
}

async function readJSON(request: IncomingMessage): Promise<{ url: string }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 16 * 1024) throw new Error("请求体过大");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || typeof (value as { url?: unknown }).url !== "string") {
    throw new Error("请求体必须包含 url 字符串");
  }
  return { url: (value as { url: string }).url };
}

async function* responseBody(response: Response): AsyncIterable<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function storeAsset(
  bytes: Uint8Array,
  contentType: RemoteImageContentType,
): Promise<{ url: string }> {
  await mkdir(assetDirectory, { recursive: true });
  const filename = `${createHash("sha256").update(bytes).digest("hex")}.${extension(contentType)}`;
  await writeFile(join(assetDirectory, filename), bytes);
  return { url: `${publicBaseURL}/${filename}` };
}

async function serveAsset(filename: string, response: ServerResponse): Promise<void> {
  if (!/^[a-f0-9]{64}\.(?:png|jpg|gif|webp)$/.test(filename)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const bytes = await readFile(join(assetDirectory, filename));
    response
      .writeHead(200, {
        "content-type": contentType(filename),
        "cache-control": "public, max-age=31536000, immutable",
      })
      .end(bytes);
  } catch {
    response.writeHead(404).end();
  }
}

function extension(contentType: RemoteImageContentType): string {
  return contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length);
}

function contentType(filename: string): RemoteImageContentType {
  const extension = filename.split(".").at(-1);
  return extension === "jpg" ? "image/jpeg" : (`image/${extension}` as RemoteImageContentType);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, { "content-type": "application/json; charset=utf-8" })
    .end(JSON.stringify(body));
}
