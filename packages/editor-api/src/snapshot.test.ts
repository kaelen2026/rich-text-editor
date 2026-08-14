import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

describe("状态快照", () => {
  it("状态未变时返回同一个引用", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));

    const snapshot = editor.getSnapshot();

    expect(editor.getSnapshot()).toBe(snapshot);
    expect(editor.getSnapshot()).toBe(snapshot);
  });

  it("选区变化换新引用但不递增文档修订号", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    const before = editor.getSnapshot();

    editor.execute("selection.selectAll");
    const after = editor.getSnapshot();

    expect(after).not.toBe(before);
    expect(after.revision).toBe(before.revision);
    expect(after.stateRevision).toBeGreaterThan(before.stateRevision);
    expect(after.dirty).toBe(false);
  });

  it("内容变更递增文档修订号并置脏，之后引用重新稳定", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    expect(editor.getRevision()).toBe(0);
    expect(editor.isDirty()).toBe(false);

    editor.execute("selection.selectAll");
    editor.execute("format.bold");

    const snapshot = editor.getSnapshot();
    expect(snapshot.revision).toBe(1);
    expect(snapshot.dirty).toBe(true);
    expect(editor.getRevision()).toBe(1);
    expect(editor.isDirty()).toBe(true);
    expect(editor.getSnapshot()).toBe(snapshot);
  });

  it("重新装载文档把修订号与脏标记归零", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    editor.execute("selection.selectAll");
    editor.execute("format.bold");

    editor.loadDocument(JSON.parse(fixtureText));

    expect(editor.getRevision()).toBe(0);
    expect(editor.isDirty()).toBe(false);
  });
});
