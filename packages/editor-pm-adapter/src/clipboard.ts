import type { ClipboardNotice, NodeJSON } from "@kaelen/editor-shared-types";
import { Fragment, type Schema, Slice } from "prosemirror-model";
import { Plugin } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { parseExternalHTML } from "./external-html";

/** Safari 等环境可能丢掉它，因此只作为内部复制的快速通道。 */
export const CLIPBOARD_MIME = "application/x-company-editor+json";
export const CLIPBOARD_ATTRIBUTE = "data-co-slice";
export type { ClipboardNotice } from "@kaelen/editor-shared-types";

const MAX_PASTE_HTML_BYTES = 2 * 1024 * 1024;
const MAX_PASTE_FILES = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
  /** 粘贴被安全策略拒绝或降级时交给宿主呈现给用户。 */
  onNotice?(notice: ClipboardNotice): void;
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
 * 内部 payload 优先恢复高保真 Slice；外部 HTML 则经 inert document 和 Schema
 * 白名单管线解析，绝不交给默认的活 DOM 粘贴路径。
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

          const html = data.getData("text/html");
          if (byteLength(html) > MAX_PASTE_HTML_BYTES) {
            clipboardEvent.preventDefault();
            notify(options, "html-too-large", "粘贴的 HTML 超过 2MB，已降级为纯文本");
            view.pasteText(data.getData("text/plain"), clipboardEvent);
            return true;
          }

          const payload =
            decodeClipboardPayload(data.getData(CLIPBOARD_MIME)) ??
            decodeClipboardPayloadFromHTML(html);
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
          const files = acceptedFiles(data.files, options);
          if (files.length > 0 && options.handleFiles?.(view, files)) {
            clipboardEvent.preventDefault();
            return true;
          }
          if (html) {
            clipboardEvent.preventDefault();
            if (containsFileImage(html)) {
              notify(options, "word-file-image", "Word 图片无法读取，请手动插入图片");
            }
            if (containsOversizedTable(html)) {
              notify(options, "table-limit", "表格最多包含 5000 个单元格，已降级为纯文本");
            }
            const slice = parseExternalHTML(view.state.schema, html);
            if (slice.content.size > 0) {
              view.dispatch(
                view.state.tr.replaceSelection(slice).scrollIntoView().setMeta("paste", true),
              );
            } else {
              view.pasteText(data.getData("text/plain"), clipboardEvent);
            }
            return true;
          }
          const plain = data.getData("text/plain");
          const tsv = parseTSVSlice(view.state.schema, plain);
          if (tsv) {
            clipboardEvent.preventDefault();
            view.dispatch(
              view.state.tr.replaceSelection(tsv).scrollIntoView().setMeta("paste", true),
            );
            return true;
          }
          if (plain.includes("\t") && hasTableSchema(view.state.schema)) {
            clipboardEvent.preventDefault();
            notify(options, "table-limit", "表格最多包含 5000 个单元格，已降级为纯文本");
            view.pasteText(plain, clipboardEvent);
            return true;
          }
          if (pastePlainURL(view, plain)) {
            clipboardEvent.preventDefault();
            return true;
          }
          return false;
        },
      },
    },
  });
}

/** Excel 的 TSV 兜底解析器：RFC 4180 风格双引号可保护制表符和换行。 */
export function parseTSV(input: string): string[][] | null {
  if (!input.includes("\t")) {
    return null;
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"') {
      if (quoted && input[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (char === "\t" && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && input[index + 1] === "\n") {
        index += 1;
      }
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }
  row.push(cell);
  if (row.length > 1 || row[0] !== "" || rows.length === 0) {
    rows.push(row);
  }
  return rows.length > 0 ? rows : null;
}

function parseTSVSlice(schema: Schema, input: string): Slice | null {
  const rows = parseTSV(input);
  if (!rows || !hasTableSchema(schema)) {
    return null;
  }
  const columns = Math.max(...rows.map((row) => row.length));
  if (rows.length * columns > 5000) {
    return null;
  }
  const table = schema.nodes.co_table;
  const tableRow = schema.nodes.co_table_row;
  const tableCell = schema.nodes.co_table_cell;
  const paragraph = schema.nodes.paragraph;
  if (!table || !tableRow || !tableCell || !paragraph) {
    return null;
  }
  try {
    return new Slice(
      Fragment.from(
        table.createChecked(
          null,
          rows.map((row) =>
            tableRow.createChecked(
              null,
              Array.from({ length: columns }, (_, index) => {
                const text = row[index] ?? "";
                return tableCell.createChecked(
                  null,
                  paragraph.createChecked(null, text ? schema.text(text) : undefined),
                );
              }),
            ),
          ),
        ),
      ),
      0,
      0,
    );
  } catch {
    return null;
  }
}

function pastePlainURL(view: EditorView, input: string): boolean {
  const href = safeURL(input);
  const link = view.state.schema.marks.co_link;
  if (!href || !link) {
    return false;
  }
  const mark = link.create({ href });
  const { from, to, empty } = view.state.selection;
  const transaction = empty
    ? view.state.tr.insertText(input).addMark(from, from + input.length, mark)
    : view.state.tr.addMark(from, to, mark);
  view.dispatch(transaction.scrollIntoView().setMeta("paste", true));
  return true;
}

function safeURL(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function acceptedFiles(files: FileList, options: ClipboardPluginOptions): FileList {
  const accepted = Array.from(files).filter((file) => {
    if (file.type.startsWith("image/") && file.size > MAX_IMAGE_BYTES) {
      notify(options, "image-too-large", "图片超过 10MB，已忽略");
      return false;
    }
    return true;
  });
  if (accepted.length > MAX_PASTE_FILES) {
    notify(options, "file-limit", "一次最多粘贴 20 个文件，已忽略超出部分");
  }
  return Object.assign(accepted.slice(0, MAX_PASTE_FILES), {
    item: (index: number) => accepted[index] ?? null,
  }) as FileList;
}

function containsFileImage(html: string): boolean {
  return /<img\b[^>]*\bsrc\s*=\s*["']file:/i.test(html);
}

function containsOversizedTable(html: string): boolean {
  const tables = html.match(/<table\b[\s\S]*?<\/table\s*>/gi) ?? [];
  return tables.some((table) => (table.match(/<(?:td|th)\b/gi) ?? []).length > 5000);
}

function notify(
  options: ClipboardPluginOptions,
  code: ClipboardNotice["code"],
  message: string,
): void {
  options.onNotice?.({ code, message });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasTableSchema(schema: Schema): boolean {
  return Boolean(schema.nodes.co_table && schema.nodes.co_table_row && schema.nodes.co_table_cell);
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
