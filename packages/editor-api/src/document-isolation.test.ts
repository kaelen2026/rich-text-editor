import { createEditor } from "@kaelen/editor-api";
import type { EditorEnvelope } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";

function envelopeWithUnknown(): EditorEnvelope {
  return {
    envelope: 1,
    schemaVersion: 1,
    plugins: { embed: 1 },
    doc: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "原文" }] },
        { type: "co_embed", attrs: { url: "https://example.com" } },
      ],
    },
    annotations: [],
  };
}

function attrsOf(envelope: EditorEnvelope, index: number): Record<string, unknown> {
  const attrs = envelope.doc.content?.[index]?.attrs;
  if (!attrs) {
    throw new Error(`第 ${index} 个节点没有 attrs`);
  }
  return attrs;
}

describe("文档与调用方的隔离", () => {
  it("装载不改写调用方传入的对象", () => {
    const editor = createEditor();
    const input = envelopeWithUnknown();
    const before = JSON.stringify(input);

    editor.loadDocument(input);

    expect(JSON.stringify(input)).toBe(before);
  });

  it("装载后调用方再改自己的对象，不影响编辑器里的未知节点", () => {
    const editor = createEditor();
    const input = envelopeWithUnknown();
    editor.loadDocument(input);

    attrsOf(input, 1).url = "被外部改掉了";

    expect(editor.getDocument().doc.content?.[1]).toEqual({
      type: "co_embed",
      attrs: { url: "https://example.com" },
    });
  });

  it("调用方改写 getDocument 的返回值，不污染编辑器状态", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithUnknown());

    attrsOf(editor.getDocument(), 1).url = "被外部改掉了";

    expect(attrsOf(editor.getDocument(), 1).url).toBe("https://example.com");
  });
});

describe("信封其余字段的隔离", () => {
  it("调用方改写 getDocument() 的 plugins，不污染编辑器状态", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithUnknown());

    editor.getDocument().plugins.embed = 999;

    expect(editor.getDocument().plugins).toEqual({ embed: 1 });
  });

  it("调用方向 getDocument() 的 annotations 追加元素，不污染编辑器状态", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithUnknown());

    editor.getDocument().annotations.push({
      id: "a1",
      from: 0,
      to: 1,
      orphaned: false,
      payload: null,
    });

    expect(editor.getDocument().annotations).toEqual([]);
  });

  it("装载后调用方改自己 annotations 里的对象，不影响编辑器", () => {
    const editor = createEditor();
    const input = envelopeWithUnknown();
    input.annotations = [
      { id: "a1", from: 0, to: 1, orphaned: false, payload: { note: "原始批注" } },
    ];
    editor.loadDocument(input);

    (input.annotations[0]?.payload as Record<string, unknown>).note = "被外部改掉了";

    expect(editor.getDocument().annotations[0]?.payload).toEqual({ note: "原始批注" });
  });
});

describe("已经是兜底形态的输入", () => {
  it("输入本身已含兜底节点时，调用方之后的改写同样不影响编辑器", () => {
    const editor = createEditor();
    const input: EditorEnvelope = {
      envelope: 1,
      schemaVersion: 1,
      plugins: {},
      doc: {
        type: "doc",
        content: [
          {
            type: "unknown_block",
            attrs: {
              nodeName: "co_embed",
              original: { type: "co_embed", attrs: { url: "https://example.com" } },
            },
          },
        ],
      },
      annotations: [],
    };
    editor.loadDocument(input);

    const original = attrsOf(input, 0).original as { attrs: Record<string, unknown> };
    original.attrs.url = "被外部改掉了";

    expect(editor.getDocument().doc.content?.[0]).toEqual({
      type: "co_embed",
      attrs: { url: "https://example.com" },
    });
  });

  it("无法结构化克隆的属性不会让装载或取回抛异常", () => {
    const editor = createEditor();
    const input = envelopeWithUnknown();
    attrsOf(input, 1).onClick = () => "不可克隆";

    const result = editor.loadDocument(input);

    expect(result.ok).toBe(true);
    expect(() => editor.getDocument()).not.toThrow();
    expect(attrsOf(editor.getDocument(), 1).url).toBe("https://example.com");
  });
});
