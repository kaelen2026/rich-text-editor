import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { Fragment, Slice } from "prosemirror-model";
import { EditorState, TextSelection } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";
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
});

class ClipboardDataStub {
  private readonly values = new Map<string, string>();
  readonly files = { length: 0 } as FileList;

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
