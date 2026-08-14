import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

describe("保存标记", () => {
  it("标记已保存后清除脏标记，但保留修订号与撤销历史", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    expect(editor.isDirty()).toBe(true);

    editor.markSaved();

    expect(editor.isDirty()).toBe(false);
    expect(editor.getRevision()).toBe(1);
    // 保存不是装载：撤销历史必须还在。
    expect(editor.queryCommand("history.undo").enabled).toBe(true);
    expect(editor.undo().ok).toBe(true);
    expect(editor.getDocument().doc).toEqual(JSON.parse(fixtureText).doc);
  });

  it("标记已保存后再次编辑重新置脏", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    editor.markSaved();

    editor.execute("format.italic");

    expect(editor.isDirty()).toBe(true);
  });
});
