import type { EditorSession, SessionBridge, SessionExtension } from "@kaelen/editor-pm-adapter";
import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import { escapeInline, escapeLinkDestination } from "@kaelen/editor-schema";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import {
  type Command,
  type EditorState,
  NodeSelection,
  Plugin,
  PluginKey,
  type Transaction,
} from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";
import {
  composeCrop,
  croppedNaturalSize,
  displaySize,
  IMAGE_FILTERS,
  type ImageAlign,
  type ImageAttrs,
  type ImageFilter,
  type ImageRotation,
  imageLayout,
  normalizeImageAttrs,
  readCrop,
  unrotateCrop,
} from "./image-attrs";

const IMAGE_NODE = "co_image";

/** 展示宽度的合理区间：太小点不中，太大撑破版心。 */
const MIN_DISPLAY_WIDTH = 24;
const MAX_DISPLAY_WIDTH = 4096;

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
/** 新插入的图片是空壳等回填，替换则要一直显示原图，两者的完成判定不同。 */
export type ImageUploadMode = "insert" | "replace";

export interface ImageUploadRecord {
  uploadId: string;
  pos: number;
  status: ImageUploadStatus;
  mode: ImageUploadMode;
  /** 替换时记录开始那一刻的资产地址，用于确认回填的还是同一张图。 */
  replacing?: string;
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
    version: "1.1.0",
    namespace: "co_",
    // 2：新增 displayWidth / crop / rotate / filter / align。旧文档缺这些键，
    // 由 Schema 默认值补齐，因此不需要迁移步骤，读旧写新都安全。
    structureVersion: 2,
    extendSchema: (schema) => {
      schema.addNode(IMAGE_NODE, {
        group: "block",
        atom: true,
        selectable: true,
        attrs: {
          src: { default: "" },
          alt: { default: "" },
          // width/height 始终是资产的原始像素尺寸，缩放与裁剪都不动它。
          width: { default: null },
          height: { default: null },
          displayWidth: { default: null },
          crop: { default: null },
          rotate: { default: 0 },
          filter: { default: "none" },
          align: { default: "none" },
        },
        // 外部 HTML 图片不在 S11 直接入文档，S12 必须先通过服务端转存与 SSRF 校验。
        toDOM: (node) => {
          const attrs = normalizeImageAttrs(node.attrs);
          const layout = imageLayout(attrs);
          return [
            "div",
            {
              class: "co-image",
              "data-align": attrs.align,
              "data-rotate": String(attrs.rotate),
              style: layout.wrapper,
            },
            [
              "div",
              { class: "co-image-frame", style: layout.frame },
              [
                "img",
                {
                  src: attrs.src,
                  alt: attrs.alt,
                  style: layout.img,
                  ...dimensionAttribute(attrs.width, "width"),
                  ...dimensionAttribute(attrs.height, "height"),
                },
              ],
            ],
          ];
        },
        /**
         * `![alt](src)`。二次编辑的那一组属性（尺寸、裁剪、旋转、滤镜、环绕）
         * 在 Markdown 里没有写法，导出时丢掉——它们本来就是非破坏性的展示属性，
         * 原图与替代文本都还在，存储格式里那组属性也一字未动（方案 §4.3）。
         *
         * 反方向刻意不做映射：Markdown 里的图片地址来源不可信，直接写进
         * `src` 就是热链（方案 §11.3.1）。导入时由 Markdown 包统一降级为链接。
         */
        toMarkdown: (node) => {
          const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
          const alt = typeof node.attrs.alt === "string" ? node.attrs.alt : "";
          return `![${escapeInline(alt)}](${escapeLinkDestination(src)})`;
        },
      });
    },
    registerCommands: (commands) => {
      commands.add("image.insert", controller.insertCommand);
      commands.add("image.insertAsset", controller.insertAssetCommand);
      commands.add("image.retry", controller.retryCommand);
      commands.add("image.cancel", controller.cancelCommand);
      commands.add("image.replace", controller.replaceCommand);
      commands.add("image.selected", selectedImageCommand);
      commands.add("image.update", updateCommand);
      commands.add("image.setAlt", setAltCommand);
      commands.add("image.resize", resizeCommand);
      commands.add("image.setAlign", setAlignCommand);
      commands.add("image.rotate", rotateCommand);
      commands.add("image.setFilter", setFilterCommand);
      commands.add("image.crop", cropCommand);
      commands.add("image.remove", removeCommand);
    },
    createSessionExtensions: () => [controller],
  };
}

/**
 * 二次编辑命令的目标解析：优先用宿主给的位置，否则取当前被整节点选中的图片。
 *
 * 位置是平台已有的公开契约（`DocumentPatch` 用的就是同一套文档扁平位置），
 * 因此浮层工具条可以把 `image.selected` 交回的 `pos` 原样带回来——不必依赖
 * "执行命令的那一刻编辑器仍持有选区"，点进输入框改替代文本时它并不成立。
 */
function resolveImage(
  state: EditorState,
  pos: unknown,
): { pos: number; node: ProseMirrorNode } | null {
  const target = explicitPosition(state, pos) ?? selectedImagePosition(state);
  if (target === null) {
    return null;
  }
  const node = state.doc.nodeAt(target);
  return node?.type.name === IMAGE_NODE ? { pos: target, node } : null;
}

function explicitPosition(state: EditorState, pos: unknown): number | null {
  return typeof pos === "number" &&
    Number.isInteger(pos) &&
    pos >= 0 &&
    pos < state.doc.content.size
    ? pos
    : null;
}

function selectedImagePosition(state: EditorState): number | null {
  const { selection } = state;
  return selection instanceof NodeSelection && selection.node.type.name === IMAGE_NODE
    ? selection.from
    : null;
}

/** 只读地看一眼目标图片。`apply=false` 的命令不会派发事务，因此可以当探针用。 */
function inspect<TValue>(
  session: EditorSession,
  read: (target: { pos: number; node: ProseMirrorNode }, state: EditorState) => TValue,
  pos: unknown,
): TValue | null {
  let value: TValue | null = null;
  session.applyCommand((state) => {
    const target = resolveImage(state, pos);
    if (target) {
      value = read(target, state);
    }
    return false;
  }, false);
  return value;
}

/**
 * 改属性的统一入口。`change` 返回 null 表示这次输入不合法或没有变化。
 *
 * 改完把整节点选区放回原处：否则每点一次工具条按钮，选区就掉了，浮层跟着消失。
 */
function updateImage(
  pos: unknown,
  change: (attrs: ImageAttrs, node: ProseMirrorNode) => Partial<ImageAttrs> | null,
): Command {
  return (state, dispatch) => {
    const target = resolveImage(state, pos);
    if (!target) {
      return false;
    }
    const patch = change(normalizeImageAttrs(target.node.attrs), target.node);
    if (!patch) {
      return false;
    }
    if (!dispatch) {
      return true;
    }
    const transaction = state.tr.setNodeMarkup(target.pos, undefined, {
      ...target.node.attrs,
      ...patch,
    });
    if (selectedImagePosition(state) === target.pos) {
      transaction.setSelection(NodeSelection.create(transaction.doc, target.pos));
    }
    dispatch(transaction);
    return true;
  };
}

/** 属性编辑命令的共同外壳：目标不是图片就是 disabled，输入不合法就是 invalid。 */
function imageAttrCommand(
  parse: (input: Record<string, unknown>, attrs: ImageAttrs) => Partial<ImageAttrs> | string,
  options: {
    active?: (attrs: ImageAttrs, input: Record<string, unknown>) => boolean;
    /** 裁剪与旋转要靠原始尺寸推导展示盒，缺了就只能禁用，不能渲染成别的样子。 */
    requiresNaturalSize?: (input: Record<string, unknown>) => boolean;
  } = {},
): SessionCommand {
  return {
    run(session, apply, input) {
      const record = inputRecord(input);
      const attrs = inspect(
        session,
        (target) => normalizeImageAttrs(target.node.attrs),
        record.pos,
      );
      if (!attrs) {
        return { ok: false, reason: "disabled", detail: "没有选中图片" };
      }
      if (options.requiresNaturalSize?.(record) && croppedNaturalSize(attrs) === null) {
        return { ok: false, reason: "disabled", detail: "这张图片缺少原始尺寸，无法裁剪或旋转" };
      }
      const parsed = parse(record, attrs);
      if (typeof parsed === "string") {
        return { ok: false, reason: "invalid", detail: parsed };
      }
      const ok = session.applyCommand(
        updateImage(record.pos, () => parsed),
        apply,
      );
      return ok ? { ok: true } : { ok: false, reason: "disabled" };
    },
    enabled(session, input) {
      const record = inputRecord(input);
      const attrs = inspect(
        session,
        (target) => normalizeImageAttrs(target.node.attrs),
        record.pos,
      );
      return (
        attrs !== null &&
        (!options.requiresNaturalSize?.(record) || croppedNaturalSize(attrs) !== null)
      );
    },
    active(session, input) {
      const record = inputRecord(input);
      const attrs = inspect(
        session,
        (target) => normalizeImageAttrs(target.node.attrs),
        record.pos,
      );
      return attrs !== null && (options.active?.(attrs, record) ?? false);
    },
  };
}

/** 宿主渲染浮层工具条所需的一切：位置、归一化属性和推导出的尺寸。 */
const selectedImageCommand: SessionCommand = {
  readOnly: true,
  run(session, _apply, input) {
    const detail = inspect(
      session,
      (target) => {
        const attrs = normalizeImageAttrs(target.node.attrs);
        return {
          pos: target.pos,
          attrs,
          naturalSize: croppedNaturalSize(attrs),
          displaySize: displaySize(attrs),
        };
      },
      inputRecord(input).pos,
    );
    return detail ? { ok: true, detail } : { ok: false, reason: "disabled" };
  },
  active: () => false,
};

/**
 * 单个属性的校验。命令与"一次写一组"的 `image.update` 共用同一份判断，
 * 免得模态框那条路径松一格、工具条那条路径严一格。
 */
const ATTR_PARSERS: Record<string, (value: unknown) => Partial<ImageAttrs> | string> = {
  alt: (value) => (typeof value === "string" ? { alt: value } : "替代文本必须是字符串"),
  displayWidth: parseDisplayWidth,
  align: (value) => (isAlign(value) ? { align: value } : "对齐方式仅支持 none/left/center/right"),
  rotate: (value) => (isRotation(value) ? { rotate: value } : "旋转仅支持 0/90/180/270"),
  filter: (value) => (isFilter(value) ? { filter: value } : "滤镜必须是内置预设之一"),
  // 这里的裁剪是**原图坐标**：模态框展示的是整幅原图，框出来的就是最终结果。
  // 相对当前画面的交互式裁剪走 `image.crop`，那条路径才需要合成与反旋转。
  crop: (value) => {
    if (value === null) {
      return { crop: null };
    }
    const crop = readCrop(value);
    return crop ? { crop } : "裁剪矩形必须是原图上 0–1 的比例区域";
  },
};

function parseDisplayWidth(value: unknown): Partial<ImageAttrs> | string {
  if (value === null) {
    return { displayWidth: null };
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "展示宽度必须是正数，或用 null 恢复原始尺寸";
  }
  return {
    displayWidth: Math.round(Math.min(MAX_DISPLAY_WIDTH, Math.max(MIN_DISPLAY_WIDTH, value))),
  };
}

/**
 * 一次写入一组属性：模态框里改完再"应用"，落成一个事务、撤销一步就回到原样。
 *
 * 只处理输入里出现过的键，没提到的属性原样保留。
 */
const updateCommand = imageAttrCommand(
  (input) => {
    const patch: Partial<ImageAttrs> = {};
    for (const [key, parse] of Object.entries(ATTR_PARSERS)) {
      if (!(key in input)) {
        continue;
      }
      const parsed = parse(input[key]);
      if (typeof parsed === "string") {
        return parsed;
      }
      Object.assign(patch, parsed);
    }
    return Object.keys(patch).length > 0 ? patch : "没有需要更新的图片属性";
  },
  { requiresNaturalSize: (input) => "rotate" in input || "crop" in input },
);

const setAltCommand = imageAttrCommand((input) => parseAttr("alt", input.alt));

const resizeCommand = imageAttrCommand((input) => parseDisplayWidth(input.width), {
  active: (attrs, input) => attrs.displayWidth === (input.width ?? null),
});

const setAlignCommand = imageAttrCommand((input) => parseAttr("align", input.align), {
  active: (attrs, input) => attrs.align === input.align,
});

const rotateCommand = imageAttrCommand(
  (input, attrs) => {
    if (isRotation(input.rotate)) {
      return { rotate: input.rotate };
    }
    if (input.turn === 1 || input.turn === -1) {
      return { rotate: ((((attrs.rotate + input.turn * 90) % 360) + 360) % 360) as ImageRotation };
    }
    return "旋转仅支持 turn: ±1 或 rotate: 0/90/180/270";
  },
  { requiresNaturalSize: () => true },
);

const setFilterCommand = imageAttrCommand((input) => parseAttr("filter", input.filter), {
  active: (attrs, input) => attrs.filter === input.filter,
});

function parseAttr(key: string, value: unknown): Partial<ImageAttrs> | string {
  return ATTR_PARSERS[key]?.(value) ?? "未知的图片属性";
}

const cropCommand = imageAttrCommand(
  (input, attrs) => {
    if (input.crop === null) {
      return { crop: null };
    }
    const relative = readCrop(input.crop);
    if (!relative) {
      return "裁剪矩形必须是当前画面上 0–1 的比例区域";
    }
    // 选框来自用户看到的画面，图片可能正转着，先转回图片自身的坐标再合成。
    return { crop: composeCrop(attrs.crop, unrotateCrop(relative, attrs.rotate)) };
  },
  { requiresNaturalSize: () => true, active: (attrs) => attrs.crop !== null },
);

const removeCommand: SessionCommand = {
  run(session, apply, input) {
    const pos = inputRecord(input).pos;
    const ok = session.applyCommand((state, dispatch) => {
      const target = resolveImage(state, pos);
      if (!target) {
        return false;
      }
      dispatch?.(state.tr.delete(target.pos, target.pos + target.node.nodeSize));
      return true;
    }, apply);
    return ok ? { ok: true } : { ok: false, reason: "disabled" };
  },
  active: () => false,
};

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function isAlign(value: unknown): value is ImageAlign {
  return value === "none" || value === "left" || value === "center" || value === "right";
}

function isRotation(value: unknown): value is ImageRotation {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function isFilter(value: unknown): value is ImageFilter {
  return typeof value === "string" && value in IMAGE_FILTERS;
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

  /** 原位替换：上传期间原图照常显示，成功才换资产，失败留在原地可重试。 */
  readonly replaceCommand: SessionCommand = {
    run: (session, apply, input) => {
      const record = inputRecord(input);
      const file = fileFrom(record);
      const target = inspect(
        session,
        ({ pos, node }) => ({ pos, src: node.attrs.src }),
        record.pos,
      );
      if (!target) {
        return { ok: false, reason: "disabled", detail: "没有选中图片" };
      }
      if (!file || !this.bridge) {
        return { ok: false, reason: "invalid", detail: "需要可上传的图片文件" };
      }
      if (!apply) {
        return { ok: true };
      }
      this.replace(target.pos, stringAttribute(target.src), file);
      return { ok: true };
    },
    enabled: (session, input) =>
      inspect(session, (target) => target.pos, inputRecord(input).pos) !== null,
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
      record: { uploadId, pos, status: "uploading", mode: "insert" },
    } satisfies UploadMeta);
    bridge.dispatch(transaction);
    this.files.set(uploadId, file);
    this.begin(uploadId, file);
  }

  private replace(pos: number, replacing: string, file: File): void {
    const bridge = this.bridge;
    if (!bridge) {
      return;
    }
    const uploadId = this.nextUploadId();
    bridge.dispatch(
      bridge.getState().tr.setMeta(imageUploadKey, {
        kind: "start",
        record: { uploadId, pos, status: "uploading", mode: "replace", replacing },
      } satisfies UploadMeta),
    );
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
    const image = record && bridge ? this.uploadTarget(record) : undefined;
    if (!bridge || !record || !image) {
      this.files.delete(uploadId);
      void this.uploader.discard?.(asset);
      return;
    }
    const state = bridge.getState();
    const transaction = state.tr
      .setNodeMarkup(record.pos, undefined, completedAttrs(record, image, asset))
      // 插入的回填不进历史：撤销要回到"没有这张图"，而不是回到 loading 态。
      // 替换正相反，它本身就是一次用户编辑，必须能被撤销回原来的图。
      .setMeta("addToHistory", record.mode === "replace")
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
    const pos = positionFrom(input) ?? bridge.getState().selection.from;
    return records.find((record) => matches(record) && record.pos === pos);
  }

  /**
   * 映射后的位置上是否还是当初那张图。插入等的是仍然空着的占位；替换要求资产
   * 地址没变过——否则在上传期间被删掉、又被别的图片占位时，回填会改错节点。
   */
  private uploadTarget(record: ImageUploadRecord): ProseMirrorNode | undefined {
    const image = this.bridge?.getState().doc.nodeAt(record.pos);
    if (image?.type.name !== IMAGE_NODE) {
      return undefined;
    }
    const matches =
      record.mode === "insert" ? image.attrs.src === "" : image.attrs.src === record.replacing;
    return matches ? image : undefined;
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

/**
 * 上传完成后落进节点的属性。
 *
 * 替换换的是"这张图是什么"，因此裁剪必须清掉——旧的裁剪矩形是相对旧图的坐标，
 * 套到新图上会截出一块毫不相干的画面。展示宽度、旋转、滤镜与环绕说的是"这张图
 * 怎么摆"，与具体像素无关，保留下来用户才不用重新调一遍。
 */
function completedAttrs(
  record: ImageUploadRecord,
  image: ProseMirrorNode,
  asset: UploadedAsset,
): Record<string, unknown> {
  return {
    ...image.attrs,
    src: asset.url,
    // 替换时用户已经写过的替代文本比上传器猜的文件名更准，只在空着时才采纳。
    alt:
      record.mode === "replace" && image.attrs.alt
        ? image.attrs.alt
        : (asset.alt ?? image.attrs.alt),
    width: asset.width ?? (record.mode === "replace" ? null : image.attrs.width),
    height: asset.height ?? (record.mode === "replace" ? null : image.attrs.height),
    ...(record.mode === "replace" ? { crop: null } : {}),
  };
}

function positionFrom(input: unknown): number | undefined {
  const pos = inputRecord(input).pos;
  return typeof pos === "number" && Number.isInteger(pos) && pos >= 0 ? pos : undefined;
}

function uploadIdFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("uploadId" in input)) {
    return undefined;
  }
  const uploadId = (input as { uploadId: unknown }).uploadId;
  return typeof uploadId === "string" && uploadId.length > 0 ? uploadId : undefined;
}

function stringAttribute(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 原始像素尺寸同时写成 HTML 属性：图片没加载完也能占对位置，不抖版。 */
function dimensionAttribute(
  value: number | null,
  attribute: "width" | "height",
): Record<string, string> {
  return value === null ? {} : { [attribute]: String(value) };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function uploadIndicator(record: ImageUploadRecord): HTMLElement {
  const action = record.mode === "replace" ? "替换" : "上传";
  const indicator = document.createElement("span");
  indicator.className = `co-image-upload-indicator co-image-${record.status}`;
  indicator.setAttribute("contenteditable", "false");
  indicator.setAttribute("aria-live", "polite");
  indicator.setAttribute("role", "status");
  indicator.dataset.uploadStatus = record.status;
  indicator.textContent =
    record.status === "uploading"
      ? `图片${action}中…`
      : `图片${action}失败：${record.error ?? "请重试"}`;
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
