import type { NodeJSON } from "@kaelen/editor-shared-types";
import { Fragment, type Schema, Slice } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

/** Safari 等环境可能丢掉它，因此只作为内部复制的快速通道。 */
export const CLIPBOARD_MIME = "application/x-company-editor+json";
export const CLIPBOARD_ATTRIBUTE = "data-co-slice";

export interface SliceJSON {
  content: NodeJSON[];
  openStart: number;
  openEnd: number;
}

export interface ClipboardPayload {
  v: 1;
  schemaVersion: number;
  plugins: Record<string, number>;
  slice: SliceJSON;
}

export interface ClipboardPayloadMeta {
  schemaVersion: number;
  plugins: Record<string, number>;
}

export interface ClipboardPluginOptions {
  getPayloadMeta(): ClipboardPayloadMeta;
  /** 没有迁移器时只能接受相同版本；调用方可在接入迁移链后放宽。 */
  acceptsSchemaVersion?(version: number): boolean;
  /** 图片/附件插件注册后在此接手文件；未接手时继续走 HTML/纯文本降级。 */
  handleFiles?(view: EditorView, files: FileList): boolean;
}

/** 将 ProseMirror Slice 化为不携带运行时对象的稳定 JSON。 */
export function serializeSlice(slice: Slice): SliceJSON {
  return {
    content: slice.content.toJSON() as NodeJSON[],
    openStart: slice.openStart,
    openEnd: slice.openEnd,
  };
}

/**
 * 从 JSON 恢复 Slice。开合深度必须能沿片段两端实际向下走到，不能把畸形
 * 剪贴板数据交给 replaceSelection（那会在粘贴过程中抛异常）。
 */
export function parseSlice(schema: Schema, input: unknown): Slice | null {
  if (!isSliceJSON(input)) {
    return null;
  }
  try {
    const content = Fragment.fromJSON(schema, input.content);
    if (!hasOpenDepth(content, input.openStart, "firstChild")) {
      return null;
    }
    if (!hasOpenDepth(content, input.openEnd, "lastChild")) {
      return null;
    }
    return new Slice(content, input.openStart, input.openEnd);
  } catch {
    return null;
  }
}

export function encodeClipboardPayload(payload: ClipboardPayload): string {
  return JSON.stringify(payload);
}

export function decodeClipboardPayload(input: string | null | undefined): ClipboardPayload | null {
  if (!input) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(input);
    if (!isClipboardPayload(value)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

/**
 * 写入语义 HTML、纯文本和可选私有 MIME。HTML 是可靠载体，私有 MIME 只缩短
 * 同浏览器内的路径；其中的 data-co-slice 保留原始 Slice 的开合深度。
 */
export function writeClipboard(
  view: EditorView,
  event: ClipboardEvent,
  meta: ClipboardPayloadMeta,
): boolean {
  const data = event.clipboardData;
  if (!data || view.state.selection.empty) {
    return false;
  }
  const slice = view.state.selection.content();
  const serialized = view.serializeForClipboard(slice);
  const payload = encodeClipboardPayload({ v: 1, ...meta, slice: serializeSlice(slice) });
  const wrapper = document.createElement("div");
  wrapper.setAttribute(CLIPBOARD_ATTRIBUTE, payload);
  wrapper.appendChild(serialized.dom);

  event.preventDefault();
  data.clearData();
  data.setData("text/html", wrapper.outerHTML);
  data.setData("text/plain", serialized.text);
  // 非标准 MIME 可能被浏览器拒绝；HTML 仍然完整承载高保真数据。
  try {
    data.setData(CLIPBOARD_MIME, payload);
  } catch {
    // Intentionally ignored: Safari and clipboard managers may not retain custom MIME types.
  }
  return true;
}

/**
 * ProseMirror 的默认 HTML/纯文本解析仍保留给外部来源。这里只抢先消费可验证的
 * 内部 payload，以及需要强制纯文本的两种场景。
 */
export function createClipboardPlugin(options: ClipboardPluginOptions): Plugin {
  let pastePlainText = false;
  const acceptsSchemaVersion =
    options.acceptsSchemaVersion ??
    ((version: number) => version === options.getPayloadMeta().schemaVersion);

  return new Plugin({
    props: {
      handleDOMEvents: {
        keydown: (_view, event) => {
          const keyboardEvent = event as KeyboardEvent;
          pastePlainText =
            keyboardEvent.key.toLowerCase() === "v" &&
            keyboardEvent.shiftKey &&
            (keyboardEvent.metaKey || keyboardEvent.ctrlKey);
          return false;
        },
        copy: (view, event) =>
          writeClipboard(view, event as ClipboardEvent, options.getPayloadMeta()),
        cut: (view, event) => {
          if (!writeClipboard(view, event as ClipboardEvent, options.getPayloadMeta())) {
            return false;
          }
          if (view.editable) {
            view.dispatch(
              view.state.tr.deleteSelection().scrollIntoView().setMeta("uiEvent", "cut"),
            );
          }
          return true;
        },
        paste: (view, event) => {
          const clipboardEvent = event as ClipboardEvent;
          if (view.composing) {
            clipboardEvent.preventDefault();
            return true;
          }

          const data = clipboardEvent.clipboardData;
          if (!data) {
            return false;
          }
          const plainText =
            pastePlainText || view.state.selection.$from.parent.type.spec.code === true;
          pastePlainText = false;
          if (plainText) {
            clipboardEvent.preventDefault();
            view.pasteText(data.getData("text/plain"), clipboardEvent);
            return true;
          }

          const payload =
            decodeClipboardPayload(data.getData(CLIPBOARD_MIME)) ??
            decodeClipboardPayloadFromHTML(data.getData("text/html"));
          if (payload && acceptsSchemaVersion(payload.schemaVersion)) {
            const slice = parseSlice(view.state.schema, payload.slice);
            if (slice) {
              clipboardEvent.preventDefault();
              view.dispatch(
                view.state.tr.replaceSelection(slice).scrollIntoView().setMeta("paste", true),
              );
              return true;
            }
          }
          if (data.files.length > 0 && options.handleFiles?.(view, data.files)) {
            clipboardEvent.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });
}

function decodeClipboardPayloadFromHTML(html: string): ClipboardPayload | null {
  if (!html || typeof DOMParser === "undefined") {
    return null;
  }
  const document = new DOMParser().parseFromString(html, "text/html");
  return decodeClipboardPayload(
    document.querySelector(`[${CLIPBOARD_ATTRIBUTE}]`)?.getAttribute(CLIPBOARD_ATTRIBUTE),
  );
}

function isClipboardPayload(value: unknown): value is ClipboardPayload {
  if (!value || typeof value !== "object") {
    return false;
  }
  const payload = value as Partial<ClipboardPayload>;
  return (
    payload.v === 1 &&
    typeof payload.schemaVersion === "number" &&
    Number.isInteger(payload.schemaVersion) &&
    payload.schemaVersion >= 1 &&
    isRecordOfNumbers(payload.plugins) &&
    isSliceJSON(payload.slice)
  );
}

function isSliceJSON(value: unknown): value is SliceJSON {
  if (!value || typeof value !== "object") {
    return false;
  }
  const slice = value as Partial<SliceJSON>;
  return (
    Array.isArray(slice.content) &&
    slice.content.every((node) => node !== null && typeof node === "object") &&
    isOpenDepth(slice.openStart) &&
    isOpenDepth(slice.openEnd)
  );
}

function isOpenDepth(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecordOfNumbers(value: unknown): value is Record<string, number> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "number" && Number.isInteger(entry))
  );
}

function hasOpenDepth(content: Fragment, depth: number, edge: "firstChild" | "lastChild"): boolean {
  let fragment = content;
  for (let index = 0; index < depth; index += 1) {
    const node = fragment[edge];
    if (!node || node.isText) {
      return false;
    }
    fragment = node.content;
  }
  return true;
}
