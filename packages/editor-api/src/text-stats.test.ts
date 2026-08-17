import type { EditorEnvelope } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { createEditor } from "./editor";

function envelopeWithText(text: string): EditorEnvelope {
  return {
    envelope: 1,
    schemaVersion: 1,
    plugins: {},
    doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] },
    annotations: [],
  };
}

describe("字数统计", () => {
  it("装载后即可读取两个口径", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithText("中文 English"));

    expect(editor.getTextStats()).toEqual({ characters: 10, charactersWithoutWhitespace: 9 });
  });

  it("同一状态内引用稳定，可直接用于框架订阅", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithText("稳定"));

    expect(editor.getTextStats()).toBe(editor.getTextStats());
  });

  it("内容变更后重新计算", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithText("四个汉字"));
    const before = editor.getTextStats();

    editor.execute("selection.selectAll");
    editor.execute("block.insertHorizontalRule");

    expect(editor.getTextStats()).not.toBe(before);
    expect(editor.getTextStats().characters).toBe(0);
  });

  it("只改格式不改字数，但快照照常刷新", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithText("加粗"));

    editor.execute("selection.selectAll");
    editor.execute("format.bold");

    expect(editor.getTextStats().characters).toBe(2);
  });
});
