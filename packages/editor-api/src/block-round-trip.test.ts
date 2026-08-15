import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { stringifyEnvelope } from "@kaelen/editor-schema";
import type { EditorEnvelope } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-blocks.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

describe("块级结构 round-trip", () => {
  it("含全部核心块节点与标记的文档装载后取回字节一致", () => {
    const editor = createEditor();

    const result = editor.loadDocument(JSON.parse(fixtureText) as EditorEnvelope);

    // 全是冻结核心集，不该有任何东西走兜底。
    expect(result).toMatchObject({ ok: true, degraded: false, unknownNodes: [], unknownMarks: [] });
    expect(stringifyEnvelope(editor.getDocument())).toBe(fixtureText);
  });

  it("编辑其中一处后其余结构保持不变", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText) as EditorEnvelope);

    expect(editor.execute("selection.selectAll").ok).toBe(true);
    expect(editor.execute("format.underline").ok).toBe(true);

    const blocks = (editor.getDocument().doc.content ?? []).map((node) => node.type);
    expect(blocks).toEqual([
      "heading",
      "heading",
      "paragraph",
      "blockquote",
      "horizontal_rule",
      "bullet_list",
      "ordered_list",
      "task_list",
      "code_block",
    ]);
  });
});
