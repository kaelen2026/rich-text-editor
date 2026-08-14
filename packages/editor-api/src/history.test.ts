import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

describe("撤销与重做", () => {
  it("撤销回到编辑前的文档，重做再回到编辑后", () => {
    const editor = createEditor();
    const loaded = JSON.parse(fixtureText);
    editor.loadDocument(loaded);
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    const edited = editor.getDocument().doc;

    expect(editor.undo().ok).toBe(true);
    expect(editor.getDocument().doc).toEqual(loaded.doc);

    expect(editor.redo().ok).toBe(true);
    expect(editor.getDocument().doc).toEqual(edited);
  });

  it("不能撤销到装载之前：装载不产生可撤销记录", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));

    expect(editor.undo().ok).toBe(false);

    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    expect(editor.undo().ok).toBe(true);
    expect(editor.undo().ok).toBe(false);
    expect(editor.getDocument().doc).toEqual(JSON.parse(fixtureText).doc);
  });

  it("撤销可用性通过 queryCommand 暴露给工具栏", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));

    expect(editor.queryCommand("history.undo").enabled).toBe(false);

    editor.execute("selection.selectAll");
    editor.execute("format.bold");

    expect(editor.queryCommand("history.undo").enabled).toBe(true);
    expect(editor.queryCommand("history.redo").enabled).toBe(false);
  });
});
