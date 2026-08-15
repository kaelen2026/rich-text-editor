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
