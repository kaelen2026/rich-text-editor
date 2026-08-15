import type { SessionBridge, SessionExtension } from "@kaelen/editor-pm-adapter";
import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import { Plugin, PluginKey, type Transaction } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

const IMAGE_NODE = "co_image";

export interface UploadedAsset {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
}

/** 服务端上传协议；取消信号与上传标识只存在运行时，绝不进入文档 JSON。 */
export interface AssetUploader {
  upload(file: File, options: { uploadId: string; signal: AbortSignal }): Promise<UploadedAsset>;
  /** 上传成功但锚点已消失时释放孤儿对象。 */
  discard?(asset: UploadedAsset): Promise<void> | void;
}

export interface ImagePluginOptions {
  uploader: AssetUploader;
}

export type ImageUploadStatus = "uploading" | "failed";

export interface ImageUploadRecord {
  uploadId: string;
  pos: number;
  status: ImageUploadStatus;
  error?: string;
}

export interface ImageUploadState {
  uploads: readonly ImageUploadRecord[];
}

type UploadMeta =
  | { kind: "start"; record: ImageUploadRecord }
  | { kind: "failed"; uploadId: string; error: string }
  | { kind: "retry"; uploadId: string }
  | { kind: "remove"; uploadId: string };

export const imageUploadKey = new PluginKey<ImageUploadState>("image-upload");

/**
 * 可选图片能力。持久化图片节点只保存最终可渲染的资源属性；上传 ID、进度及
 * 失败信息全部位于这个 PluginKey 对应的状态，且每个事务会通过 mapping 迁移位置。
 */
export function createImagePlugin(options: ImagePluginOptions): EditorPlugin {
  const controller = new ImageUploadController(options.uploader);
  return {
    name: "image",
    version: "1.0.0",
    namespace: "co_",
    structureVersion: 1,
    extendSchema: (schema) => {
      schema.addNode(IMAGE_NODE, {
        group: "block",
        atom: true,
        selectable: true,
        attrs: {
          src: { default: "" },
          alt: { default: "" },
          width: { default: null },
          height: { default: null },
        },
        // 外部 HTML 图片不在 S11 直接入文档，S12 必须先通过服务端转存与 SSRF 校验。
        toDOM: (node) => [
          "img",
          {
            src: documentSource(node.attrs.src),
            alt: stringAttribute(node.attrs.alt),
            ...positiveDimension(node.attrs.width, "width"),
            ...positiveDimension(node.attrs.height, "height"),
          },
        ],
      });
    },
    registerCommands: (commands) => {
      commands.add("image.insert", controller.insertCommand);
      commands.add("image.insertAsset", controller.insertAssetCommand);
      commands.add("image.retry", controller.retryCommand);
      commands.add("image.cancel", controller.cancelCommand);
    },
    createSessionExtensions: () => [controller],
  };
}

class ImageUploadController implements SessionExtension {
  private bridge: SessionBridge | undefined;
  private readonly active = new Map<string, AbortController>();
  private readonly files = new Map<string, File>();
  private sequence = 0;

  constructor(private readonly uploader: AssetUploader) {}

  readonly insertCommand: SessionCommand = {
    run: (_session, apply, input) => {
      const file = fileFrom(input);
      if (!file || !this.bridge) {
        return { ok: false, reason: "invalid", detail: "需要可上传的图片文件" };
      }
      if (!apply) {
        return { ok: true };
      }
      this.insert(file, altFrom(input));
      return { ok: true };
    },
    active: () => false,
  };

  /** 远端图片必须先由服务端转存；编辑器只接受其返回的最终资产 URL。 */
  readonly insertAssetCommand: SessionCommand = {
    run: (_session, apply, input) => {
      const asset = uploadedAssetFrom(input);
      if (!asset || !this.bridge) {
        return { ok: false, reason: "invalid", detail: "需要服务端转存后的图片资产" };
      }
      if (!apply) {
        return { ok: true };
      }
      this.insertAsset(asset);
      return { ok: true };
    },
    active: () => false,
  };

  readonly retryCommand: SessionCommand = {
    run: (_session, apply, input) => {
      const record = this.recordForInput(input, "failed");
      const file = record ? this.files.get(record.uploadId) : undefined;
      if (!record || !file || !this.bridge) {
        return { ok: false, reason: "disabled" };
      }
      if (!apply) {
        return { ok: true };
      }
      this.bridge.dispatch(
        this.bridge.getState().tr.setMeta(imageUploadKey, {
          kind: "retry",
          uploadId: record.uploadId,
        } satisfies UploadMeta),
      );
      this.begin(record.uploadId, file);
      return { ok: true };
    },
    active: () => false,
  };

  readonly cancelCommand: SessionCommand = {
    run: (_session, apply, input) => {
      const record = this.recordForInput(input);
      if (!record || !this.bridge) {
        return { ok: false, reason: "disabled" };
      }
      if (!apply) {
        return { ok: true };
      }
      this.active.get(record.uploadId)?.abort();
      this.active.delete(record.uploadId);
      this.files.delete(record.uploadId);
      this.remove(record.uploadId);
      return { ok: true };
    },
    active: () => false,
  };

  plugins(): readonly Plugin[] {
    return [
      new Plugin<ImageUploadState>({
        key: imageUploadKey,
        state: {
          init: () => ({ uploads: [] }),
          apply: (transaction, value) => {
            let uploads = value.uploads.map((record) => ({
              ...record,
              pos: transaction.mapping.map(record.pos, 1),
            }));
            const meta = transaction.getMeta(imageUploadKey) as UploadMeta | undefined;
            if (!meta) {
              return { uploads };
            }
            if (meta.kind === "start") {
              return { uploads: [...uploads, meta.record] };
            }
            if (meta.kind === "failed") {
              uploads = uploads.map((record) =>
                record.uploadId === meta.uploadId
                  ? { ...record, status: "failed", error: meta.error }
                  : record,
              );
              return { uploads };
            }
            if (meta.kind === "retry") {
              uploads = uploads.map((record) =>
                record.uploadId === meta.uploadId
                  ? { ...record, status: "uploading", error: undefined }
                  : record,
              );
              return { uploads };
            }
            return { uploads: uploads.filter((record) => record.uploadId !== meta.uploadId) };
          },
        },
        props: {
          decorations: (state) => this.decorations(state),
          handleDOMEvents: {
            paste: (_view, event) => this.handleFiles(event as ClipboardEvent),
            drop: (_view, event) => this.handleFiles(event as DragEvent),
          },
        },
      }),
    ];
  }

  bind(bridge: SessionBridge): void {
    this.bridge = bridge;
  }

  /** React StrictMode 的 unmount 与真正 destroy 都必须中止仍在飞行的请求。 */
  unmount(): void {
    const uploadIds = this.abortAll();
    for (const uploadId of uploadIds) {
      this.remove(uploadId);
    }
  }

  destroy(): void {
    this.abortAll();
    this.bridge = undefined;
  }

  private insert(file: File, alt = file.name): void {
    const bridge = this.bridge;
    if (!bridge) {
      return;
    }
    const nodeType = bridge.schema.nodes[IMAGE_NODE];
    if (!nodeType) {
      return;
    }
    const uploadId = this.nextUploadId();
    const state = bridge.getState();
    const transaction = state.tr.replaceSelectionWith(
      nodeType.create({ src: "", alt, width: null, height: null }),
    );
    const pos = insertedImagePosition(transaction, state.selection.from, alt);
    transaction.setMeta(imageUploadKey, {
      kind: "start",
      record: { uploadId, pos, status: "uploading" },
    } satisfies UploadMeta);
    bridge.dispatch(transaction);
    this.files.set(uploadId, file);
    this.begin(uploadId, file);
  }

  private insertAsset(asset: UploadedAsset): void {
    const bridge = this.bridge;
    const nodeType = bridge?.schema.nodes[IMAGE_NODE];
    if (!bridge || !nodeType) {
      return;
    }
    bridge.dispatch(
      bridge.getState().tr.replaceSelectionWith(
        nodeType.create({
          src: asset.url,
          alt: asset.alt ?? "",
          width: asset.width ?? null,
          height: asset.height ?? null,
        }),
      ),
    );
  }

  private handleFiles(event: ClipboardEvent | DragEvent): boolean {
    const files = "clipboardData" in event ? event.clipboardData?.files : event.dataTransfer?.files;
    if (!files || files.length === 0 || !this.bridge) {
      return false;
    }
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) {
      return false;
    }
    event.preventDefault();
    for (const file of images) {
      this.insert(file);
    }
    return true;
  }

  private begin(uploadId: string, file: File): void {
    const abort = new AbortController();
    this.active.set(uploadId, abort);
    void this.uploader
      .upload(file, { uploadId, signal: abort.signal })
      .then((asset) => this.complete(uploadId, asset))
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          this.fail(uploadId, error);
        }
      });
  }

  private complete(uploadId: string, asset: UploadedAsset): void {
    this.active.delete(uploadId);
    const bridge = this.bridge;
    const record = this.record(uploadId);
    if (!bridge || !record || !this.isPendingImage(record.pos)) {
      this.files.delete(uploadId);
      void this.uploader.discard?.(asset);
      return;
    }
    const state = bridge.getState();
    const image = state.doc.nodeAt(record.pos);
    if (!image) {
      this.files.delete(uploadId);
      void this.uploader.discard?.(asset);
      return;
    }
    const transaction = state.tr
      .setNodeMarkup(record.pos, undefined, {
        ...image.attrs,
        src: asset.url,
        alt: asset.alt ?? image.attrs.alt,
        width: asset.width ?? image.attrs.width,
        height: asset.height ?? image.attrs.height,
      })
      .setMeta("addToHistory", false)
      .setMeta(imageUploadKey, { kind: "remove", uploadId } satisfies UploadMeta);
    bridge.dispatch(transaction);
    this.files.delete(uploadId);
  }

  private fail(uploadId: string, error: unknown): void {
    this.active.delete(uploadId);
    const bridge = this.bridge;
    if (!bridge || !this.record(uploadId)) {
      return;
    }
    bridge.dispatch(
      bridge.getState().tr.setMeta(imageUploadKey, {
        kind: "failed",
        uploadId,
        error: describeError(error),
      } satisfies UploadMeta),
    );
  }

  private remove(uploadId: string): void {
    if (this.bridge) {
      this.bridge.dispatch(
        this.bridge
          .getState()
          .tr.setMeta(imageUploadKey, { kind: "remove", uploadId } satisfies UploadMeta),
      );
    }
  }

  private record(uploadId: string): ImageUploadRecord | undefined {
    const bridge = this.bridge;
    return bridge
      ? imageUploadKey
          .getState(bridge.getState())
          ?.uploads.find((record) => record.uploadId === uploadId)
      : undefined;
  }

  /** 工具栏可直接对当前选中的失败图片重试，无需把运行时 uploadId 暴露进文档。 */
  private recordForInput(
    input: unknown,
    status?: ImageUploadStatus,
  ): ImageUploadRecord | undefined {
    const explicit = uploadIdFrom(input);
    const bridge = this.bridge;
    if (!bridge) {
      return undefined;
    }
    const records = imageUploadKey.getState(bridge.getState())?.uploads ?? [];
    const matches = (record: ImageUploadRecord) => !status || record.status === status;
    if (explicit) {
      return records.find((record) => record.uploadId === explicit && matches(record));
    }
    return records.find(
      (record) => matches(record) && record.pos === bridge.getState().selection.from,
    );
  }

  private isPendingImage(pos: number): boolean {
    const image = this.bridge?.getState().doc.nodeAt(pos);
    return image?.type.name === IMAGE_NODE && image.attrs.src === "";
  }

  private decorations(
    state: Parameters<NonNullable<Plugin["props"]["decorations"]>>[0],
  ): DecorationSet {
    const uploadState = imageUploadKey.getState(state);
    if (!uploadState) {
      return DecorationSet.empty;
    }
    const decorations = uploadState.uploads.flatMap((record) => {
      const image = state.doc.nodeAt(record.pos);
      if (image?.type.name !== IMAGE_NODE) {
        return [];
      }
      return [
        Decoration.node(record.pos, record.pos + image.nodeSize, {
          class: `co-image-${record.status}`,
          "data-upload-status": record.status,
          ...(record.error ? { "data-upload-error": record.error } : {}),
        }),
        Decoration.widget(record.pos, () => uploadIndicator(record), {
          side: -1,
          key: `image-upload-${record.uploadId}`,
        }),
      ];
    });
    return DecorationSet.create(state.doc, decorations);
  }

  private abortAll(): string[] {
    const uploadIds = [...this.active.keys()];
    for (const abort of this.active.values()) {
      abort.abort();
    }
    this.active.clear();
    return uploadIds;
  }

  private nextUploadId(): string {
    this.sequence += 1;
    return `upload-${Date.now().toString(36)}-${this.sequence}`;
  }
}

function fileFrom(input: unknown): File | undefined {
  if (!input || typeof input !== "object" || !("file" in input)) {
    return undefined;
  }
  const file = (input as { file: unknown }).file;
  return typeof File !== "undefined" && file instanceof File && file.type.startsWith("image/")
    ? file
    : undefined;
}

function altFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("alt" in input)) {
    return undefined;
  }
  const alt = (input as { alt: unknown }).alt;
  return typeof alt === "string" ? alt : undefined;
}

function uploadedAssetFrom(input: unknown): UploadedAsset | undefined {
  if (!input || typeof input !== "object" || !("asset" in input)) {
    return undefined;
  }
  const asset = (input as { asset: unknown }).asset;
  if (!asset || typeof asset !== "object" || typeof (asset as { url?: unknown }).url !== "string") {
    return undefined;
  }
  const { url, alt, width, height } = asset as Record<string, unknown>;
  try {
    if (!url || !["http:", "https:"].includes(new URL(url as string).protocol)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    url: url as string,
    ...(typeof alt === "string" ? { alt } : {}),
    ...(typeof width === "number" && Number.isFinite(width) && width > 0 ? { width } : {}),
    ...(typeof height === "number" && Number.isFinite(height) && height > 0 ? { height } : {}),
  };
}

function uploadIdFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("uploadId" in input)) {
    return undefined;
  }
  const uploadId = (input as { uploadId: unknown }).uploadId;
  return typeof uploadId === "string" && uploadId.length > 0 ? uploadId : undefined;
}

function documentSource(value: unknown): string {
  // data: 只可能作为瞬时本地预览，永远不能进入可保存文档。
  return typeof value === "string" && !value.startsWith("data:") ? value : "";
}

function stringAttribute(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function positiveDimension(value: unknown, attribute: "width" | "height"): Record<string, string> {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? { [attribute]: String(Math.floor(value)) }
    : {};
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uploadIndicator(record: ImageUploadRecord): HTMLElement {
  const indicator = document.createElement("span");
  indicator.className = `co-image-upload-indicator co-image-${record.status}`;
  indicator.setAttribute("contenteditable", "false");
  indicator.setAttribute("aria-live", "polite");
  indicator.setAttribute("role", "status");
  indicator.dataset.uploadStatus = record.status;
  indicator.textContent =
    record.status === "uploading" ? "图片上传中…" : `图片上传失败：${record.error ?? "请重试"}`;
  return indicator;
}

/**
 * 插入块原子节点后 PM 通常把文本光标放在它后方，不能直接取 transaction.selection。
 * 从新旧 mapping 反查新生成的节点：反向 mapping 标记为 deleted 的位置属于本次
 * 插入，随后按与原选区的距离消除同名图片的歧义。
 */
function insertedImagePosition(
  transaction: Transaction,
  previousSelection: number,
  alt: string,
): number {
  const inverse = transaction.mapping.invert();
  let best: { pos: number; rank: number; distance: number } | undefined;
  transaction.doc.descendants((node, pos) => {
    if (node.type.name !== IMAGE_NODE || node.attrs.src !== "" || node.attrs.alt !== alt) {
      return true;
    }
    const mapped = inverse.mapResult(pos, -1);
    const candidate = {
      pos,
      rank: mapped.deleted ? 0 : 1,
      distance: Math.abs(mapped.pos - previousSelection),
    };
    if (
      !best ||
      candidate.rank < best.rank ||
      (candidate.rank === best.rank && candidate.distance < best.distance)
    ) {
      best = candidate;
    }
    return false;
  });
  if (best) {
    return best.pos;
  }
  throw new Error("图片插入后未找到上传目标");
}
