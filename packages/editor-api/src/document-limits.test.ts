import {
  DOCUMENT_JSON_LIMIT_BYTES,
  DOCUMENT_NODE_LIMIT,
  type DocumentLimitNotice,
  type EditorEnvelope,
  type NodeJSON,
} from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { createEditor } from "./editor";

/** 每个段落带一个文本节点，因此节点数是段落数的两倍。 */
function envelopeWithParagraphs(paragraphs: number): EditorEnvelope {
  const content: NodeJSON[] = Array.from({ length: paragraphs }, (_, index) => ({
    type: "paragraph",
    content: [{ type: "text", text: `第 ${index} 段` }],
  }));
  return {
    envelope: 1,
    schemaVersion: 1,
    plugins: {},
    doc: { type: "doc", content },
    annotations: [],
  };
}

describe("文档节点数上限", () => {
  it("已经超过上限的历史文档照常打开——拒绝装载就是丢内容", () => {
    const editor = createEditor();
    const oversized = envelopeWithParagraphs(DOCUMENT_NODE_LIMIT / 2 + 10);

    const result = editor.loadDocument(oversized);

    expect(result.ok).toBe(true);
    expect(editor.getDocument().doc.content).toHaveLength(DOCUMENT_NODE_LIMIT / 2 + 10);
  });

  it("插入把节点数顶出上限时命令失败，文档一字不变，并通知宿主", () => {
    const editor = createEditor();
    // 每个软换行正好加一个节点，因此边界是可数的：19998 → 19999 → 20000 → 拒绝。
    editor.loadDocument(envelopeWithParagraphs(DOCUMENT_NODE_LIMIT / 2 - 1));
    const notices: DocumentLimitNotice[] = [];
    editor.subscribe("limitExceeded", (notice) => notices.push(notice));

    expect(editor.execute("block.insertHardBreak").ok).toBe(true);
    expect(editor.execute("block.insertHardBreak").ok).toBe(true);
    expect(notices).toHaveLength(0);

    const before = JSON.stringify(editor.getDocument());
    const revision = editor.getRevision();
    const rejected = editor.execute("block.insertHardBreak");

    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(editor.getDocument())).toBe(before);
    expect(editor.getRevision()).toBe(revision);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      code: "document-node-limit",
      limit: DOCUMENT_NODE_LIMIT,
      actual: DOCUMENT_NODE_LIMIT + 1,
    });
  });

  it("上限之内的插入不受影响", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithParagraphs(3));

    expect(editor.execute("block.insertHorizontalRule").ok).toBe(true);
  });
});

describe("文档字节数上限", () => {
  it("按 UTF-8 字节报告信封大小，CJK 不按字符数算", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithParagraphs(3));

    const serialized = JSON.stringify(editor.getDocument());

    expect(editor.getDocumentSize()).toBe(new TextEncoder().encode(serialized).length);
    expect(editor.getDocumentSize()).toBeGreaterThan(serialized.length);
  });

  it("文档变化后重新计算", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeWithParagraphs(3));
    const before = editor.getDocumentSize();

    editor.execute("block.insertHorizontalRule");

    expect(editor.getDocumentSize()).toBeGreaterThan(before);
    expect(editor.getDocumentSize()).toBeLessThan(DOCUMENT_JSON_LIMIT_BYTES);
  });
});
