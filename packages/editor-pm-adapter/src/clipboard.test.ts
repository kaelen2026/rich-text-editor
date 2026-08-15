import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CoreMarkSpec, CoreNodeSpec } from "@kaelen/editor-shared-types";
import { JSDOM } from "jsdom";
import { Fragment, Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
import { createTablePlugin } from "../../editor-plugin-table/src/table-plugin";
import {
  CLIPBOARD_MIME,
  createClipboardPlugin,
  decodeClipboardPayload,
  encodeClipboardPayload,
  parseSlice,
  serializeSlice,
} from "./clipboard";
import { buildSchema } from "./schema";

const schema = buildSchema();

function paragraph(text: string) {
  return schema.node("paragraph", undefined, schema.text(text));
}

describe("内部 Slice 剪贴板协议", () => {
  it.each([
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ])("保留 Slice 的 openStart=%i、openEnd=%i 和内容", (openStart, openEnd) => {
    const slice = new Slice(Fragment.from(paragraph("中间")), openStart, openEnd);

    const encoded = serializeSlice(slice);
    const restored = parseSlice(schema, encoded);

    expect(encoded).toEqual({
      content: [{ type: "paragraph", content: [{ type: "text", text: "中间" }] }],
      openStart,
      openEnd,
    });
    expect(restored?.content.toJSON()).toEqual(slice.content.toJSON());
    expect(restored?.openStart).toBe(openStart);
    expect(restored?.openEnd).toBe(openEnd);
  });

  it("拒绝不可能的开合深度，避免损坏文档", () => {
    expect(
      parseSlice(schema, {
        content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
        openStart: 2,
        openEnd: 1,
      }),
    ).toBeNull();
  });

  it("编码的 payload 能从 data-co-slice 与自定义 MIME 共用", () => {
    const payload = {
      v: 1 as const,
      schemaVersion: 1,
      plugins: { link: 1 },
      slice: serializeSlice(new Slice(Fragment.from(paragraph("高保真")), 1, 1)),
    };

    const encoded = encodeClipboardPayload(payload);

    expect(CLIPBOARD_MIME).toBe("application/x-company-editor+json");
    expect(decodeClipboardPayload(encoded)).toEqual(payload);
  });

  it("fixtures 中的自产 dump 与黄金 Slice 一致", async () => {
    const fixturePath = resolve(
      import.meta.dirname,
      "../../../fixtures/clipboard/internal-slice.dump.json",
    );
    const goldenPath = resolve(
      import.meta.dirname,
      "../../../fixtures/clipboard/internal-slice.golden.json",
    );
    const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as Record<string, string>;
    const golden = JSON.parse(await readFile(goldenPath, "utf8"));
    const payload = decodeClipboardPayload(fixture[CLIPBOARD_MIME]);

    expect(payload).not.toBeNull();
    expect(parseSlice(schema, payload?.slice)?.toJSON()).toEqual(golden);
    expect(fixture["text/html"]).toContain("data-co-slice");
    expect(fixture["text/plain"]).toBe("第一段\n\n第二段");
  });

  it("复制把 Slice 写入 data-co-slice，并在另一视图优先恢复", () => {
    usingDOM((host) => {
      const plugin = createClipboardPlugin({
        getPayloadMeta: () => ({ schemaVersion: 1, plugins: {} }),
      });
      const sourceDoc = schema.node("doc", undefined, [paragraph("高保真文本")]);
      const source = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc: sourceDoc,
          selection: TextSelection.create(sourceDoc, 1, sourceDoc.content.size - 1),
          plugins: [plugin],
        }),
      });
      const data = new ClipboardDataStub();
      const copyEvent = clipboardEvent(data);

      expect(plugin.props.handleDOMEvents?.copy?.call(plugin, source, copyEvent)).toBe(true);
      expect(copyEvent.preventDefault).toHaveBeenCalledOnce();
      expect(data.getData("text/html")).toContain("data-co-slice");
      expect(data.getData("text/plain")).toBe("高保真文本");

      const targetDoc = schema.node("doc", undefined, [paragraph("目标")]);
      const target = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc: targetDoc,
          selection: TextSelection.create(targetDoc, 1, 3),
          plugins: [plugin],
        }),
      });
      const htmlOnlyData = new ClipboardDataStub();
      htmlOnlyData.setData("text/html", data.getData("text/html"));
      htmlOnlyData.setData("text/plain", data.getData("text/plain"));
      const pasteEvent = clipboardEvent(htmlOnlyData);

      expect(plugin.props.handleDOMEvents?.paste?.call(plugin, target, pasteEvent)).toBe(true);
      expect(target.state.doc.textContent).toBe("高保真文本");
      source.destroy();
      target.destroy();
    });
  });

  it("无格式快捷键和代码块粘贴只读取 text/plain", () => {
    usingDOM((host) => {
      const plugin = createClipboardPlugin({
        getPayloadMeta: () => ({ schemaVersion: 1, plugins: {} }),
      });
      const doc = schema.node("doc", undefined, [
        schema.node("code_block", undefined, schema.text("旧")),
      ]);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 1, 2),
          plugins: [plugin],
        }),
      });
      const data = new ClipboardDataStub();
      data.setData("text/html", "<p><strong>富文本</strong></p>");
      data.setData("text/plain", "const pasted = true");

      expect(plugin.props.handleDOMEvents?.paste?.call(plugin, view, clipboardEvent(data))).toBe(
        true,
      );
      expect(view.state.doc.textContent).toBe("const pasted = true");
      view.destroy();

      const plainDoc = schema.node("doc", undefined, [paragraph("旧")]);
      const plainView = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc: plainDoc,
          selection: TextSelection.create(plainDoc, 1, 2),
          plugins: [plugin],
        }),
      });
      expect(
        plugin.props.handleDOMEvents?.keydown?.call(
          plugin,
          plainView,
          new KeyboardEvent("keydown", { key: "v", metaKey: true, shiftKey: true }),
        ),
      ).toBe(false);
      expect(
        plugin.props.handleDOMEvents?.paste?.call(plugin, plainView, clipboardEvent(data)),
      ).toBe(true);
      expect(plainView.state.doc.textContent).toBe("const pasted = true");
      expect(plainView.state.doc.firstChild?.firstChild?.marks).toHaveLength(0);
      plainView.destroy();
    });
  });

  it("外部 HTML 通过 Schema 白名单解析，不能回落到默认粘贴", () => {
    usingDOM((host) => {
      const plugin = createClipboardPlugin({
        getPayloadMeta: () => ({ schemaVersion: 1, plugins: {} }),
      });
      const doc = schema.node("doc", undefined, [paragraph("旧内容")]);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 1, doc.content.size - 1),
          plugins: [plugin],
        }),
      });
      const data = new ClipboardDataStub();
      data.setData(
        "text/html",
        '<h6 onclick="alert(1)">标题</h6><p><strong>正文</strong><img src="https://tracker.example/pixel"></p>',
      );
      data.setData("text/plain", "标题\n正文");
      const event = clipboardEvent(data);

      expect(plugin.props.handleDOMEvents?.paste?.call(plugin, view, event)).toBe(true);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(view.state.doc.toJSON()).toEqual({
        type: "doc",
        content: [
          { type: "heading", attrs: { level: 4 }, content: [{ type: "text", text: "标题" }] },
          {
            type: "paragraph",
            content: [{ type: "text", marks: [{ type: "strong" }], text: "正文" }],
          },
        ],
      });
      view.destroy();
    });
  });

  it("Word 的 file: 图片会丢弃并通过提示回调说明需手动插入", () => {
    usingDOM((host) => {
      const notices: string[] = [];
      const plugin = createClipboardPlugin({
        getPayloadMeta: () => ({ schemaVersion: 1, plugins: {} }),
        onNotice: (notice) => notices.push(notice.message),
      });
      const doc = schema.node("doc", undefined, [paragraph("旧内容")]);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 1, doc.content.size - 1),
          plugins: [plugin],
        }),
      });
      const data = new ClipboardDataStub();
      data.setData("text/html", '<p>保留文字<img src="file:///C:/Users/Alice/a.png"></p>');
      data.setData("text/plain", "保留文字");

      expect(plugin.props.handleDOMEvents?.paste?.call(plugin, view, clipboardEvent(data))).toBe(
        true,
      );
      expect(view.state.doc.textContent).toBe("保留文字");
      expect(notices).toEqual(["Word 图片无法读取，请手动插入图片"]);
      view.destroy();
    });
  });

  it("Excel 没有 HTML 时按带引号转义的 TSV 还原表格单元格", () => {
    usingDOM((host) => {
      const tableSchema = schemaWithTable();
      const plugin = createClipboardPlugin({
        getPayloadMeta: () => ({ schemaVersion: 1, plugins: {} }),
      });
      const doc = tableSchema.node("doc", undefined, [tableSchema.node("paragraph")]);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema: tableSchema,
          doc,
          selection: TextSelection.create(doc, 1),
          plugins: [plugin],
        }),
      });
      const data = new ClipboardDataStub();
      data.setData("text/plain", '姓名\t备注\r\n张三\t"含\t制表符和\n换行"');

      expect(plugin.props.handleDOMEvents?.paste?.call(plugin, view, clipboardEvent(data))).toBe(
        true,
      );
      expect(view.state.doc.toJSON()).toEqual({
        type: "doc",
        content: [
          {
            type: "co_table",
            content: [
              {
                type: "co_table_row",
                content: [
                  {
                    type: "co_table_cell",
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    content: [{ type: "paragraph", content: [{ type: "text", text: "姓名" }] }],
                  },
                  {
                    type: "co_table_cell",
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    content: [{ type: "paragraph", content: [{ type: "text", text: "备注" }] }],
                  },
                ],
              },
              {
                type: "co_table_row",
                content: [
                  {
                    type: "co_table_cell",
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    content: [{ type: "paragraph", content: [{ type: "text", text: "张三" }] }],
                  },
                  {
                    type: "co_table_cell",
                    attrs: { colspan: 1, rowspan: 1, colwidth: null },
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "含\t制表符和\n换行" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
      view.destroy();
    });
  });

  it("纯文本 URL 在选区上应用链接，在空选区插入链接文本", () => {
    usingDOM((host) => {
      const linkSchema = buildSchema({
        marks: {
          co_link: {
            attrs: { href: {} },
            parseDOM: [{ tag: "a", attrsFromDOM: { href: "href" } }],
            toDOM: () => ["a", 0],
          },
        },
      });
      const plugin = createClipboardPlugin({
        getPayloadMeta: () => ({ schemaVersion: 1, plugins: {} }),
      });
      const doc = linkSchema.node("doc", undefined, [
        linkSchema.node("paragraph", undefined, linkSchema.text("选择我")),
      ]);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema: linkSchema,
          doc,
          selection: TextSelection.create(doc, 1, 4),
          plugins: [plugin],
        }),
      });
      const data = new ClipboardDataStub();
      data.setData("text/plain", "https://example.com/path");

      expect(plugin.props.handleDOMEvents?.paste?.call(plugin, view, clipboardEvent(data))).toBe(
        true,
      );
      expect(view.state.doc.textContent).toBe("选择我");
      expect(view.state.doc.firstChild?.firstChild?.marks).toEqual([
        linkSchema.marks.co_link?.create({ href: "https://example.com/path" }),
      ]);

      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, 4)));
      expect(plugin.props.handleDOMEvents?.paste?.call(plugin, view, clipboardEvent(data))).toBe(
        true,
      );
      expect(view.state.doc.toJSON()).toEqual({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                marks: [{ type: "co_link", attrs: { href: "https://example.com/path" } }],
                text: "选择我https://example.com/path",
              },
            ],
          },
        ],
      });
      view.destroy();
    });
  });

  it("超出 HTML 和文件阈值会降级或截断，并通过提示回调告知用户", () => {
    usingDOM((host) => {
      const notices: string[] = [];
      const received: FileList[] = [];
      const plugin = createClipboardPlugin({
        getPayloadMeta: () => ({ schemaVersion: 1, plugins: {} }),
        onNotice: (notice) => notices.push(notice.message),
        handleFiles: (_view, files) => {
          received.push(files);
          return true;
        },
      });
      const doc = schema.node("doc", undefined, [paragraph("旧")]);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 1, 2),
          plugins: [plugin],
        }),
      });
      const htmlData = new ClipboardDataStub();
      htmlData.setData("text/html", `<p>${"x".repeat(2 * 1024 * 1024 + 1)}</p>`);
      htmlData.setData("text/plain", "降级文本");
      expect(
        plugin.props.handleDOMEvents?.paste?.call(plugin, view, clipboardEvent(htmlData)),
      ).toBe(true);
      expect(view.state.doc.textContent).toBe("降级文本");

      const files = Array.from(
        { length: 21 },
        (_, index) => new File(["image"], `${index}.png`, { type: "image/png" }),
      );
      const fileData = new ClipboardDataStub(files);
      expect(
        plugin.props.handleDOMEvents?.paste?.call(plugin, view, clipboardEvent(fileData)),
      ).toBe(true);
      expect(received).toHaveLength(1);
      expect(received[0]).toHaveLength(20);
      expect(notices).toEqual([
        "粘贴的 HTML 超过 2MB，已降级为纯文本",
        "一次最多粘贴 20 个文件，已忽略超出部分",
      ]);
      view.destroy();
    });
  });

  it("超过 10MB 的单张图片会在交给上传插件前被拒绝", () => {
    usingDOM((host) => {
      const notices: string[] = [];
      const handleFiles = vi.fn(() => true);
      const plugin = createClipboardPlugin({
        getPayloadMeta: () => ({ schemaVersion: 1, plugins: {} }),
        handleFiles,
        onNotice: (notice) => notices.push(notice.message),
      });
      const doc = schema.node("doc", undefined, [paragraph("旧")]);
      const view = new EditorView(host, {
        state: EditorState.create({
          schema,
          doc,
          selection: TextSelection.create(doc, 1, 2),
          plugins: [plugin],
        }),
      });
      const data = new ClipboardDataStub([
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
      ]);

      expect(plugin.props.handleDOMEvents?.paste?.call(plugin, view, clipboardEvent(data))).toBe(
        false,
      );
      expect(handleFiles).not.toHaveBeenCalled();
      expect(notices).toEqual(["图片超过 10MB，已忽略"]);
      view.destroy();
    });
  });
});

class ClipboardDataStub {
  private readonly values = new Map<string, string>();
  readonly files: FileList;

  constructor(files: readonly File[] = []) {
    this.files = Object.assign([...files], {
      item: (index: number) => files[index] ?? null,
    }) as FileList;
  }

  clearData(): void {
    this.values.clear();
  }

  getData(type: string): string {
    return this.values.get(type) ?? "";
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }
}

function schemaWithTable() {
  const plugin = createTablePlugin();
  const nodes: Record<string, CoreNodeSpec> = {};
  plugin.extendSchema?.({
    addNode: (name, spec) => {
      nodes[name] = spec;
    },
    addMark: (_name: string, _spec: CoreMarkSpec) => undefined,
  });
  return buildSchema({ nodes });
}

function clipboardEvent(data: ClipboardDataStub): ClipboardEvent {
  return {
    clipboardData: data,
    preventDefault: vi.fn(),
  } as unknown as ClipboardEvent;
}

function usingDOM(run: (host: HTMLElement) => void): void {
  const dom = new JSDOM("<!doctype html><html><body><div id=host></div></body></html>");
  Object.assign(globalThis, {
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    HTMLElement: dom.window.HTMLElement,
    KeyboardEvent: dom.window.KeyboardEvent,
    Node: dom.window.Node,
    window: dom.window,
  });
  const host = dom.window.document.getElementById("host");
  if (!host) {
    throw new Error("missing test host");
  }
  run(host);
  dom.window.close();
}
