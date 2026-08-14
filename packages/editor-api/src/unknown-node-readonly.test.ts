// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { beforeEach, describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-with-unknown.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

describe("兜底节点的只读性", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  it("占位块渲染为不可编辑，并说明缺哪个功能", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    editor.mount(host);

    const placeholder = host.querySelector('[data-unknown-node="co_table"]');

    expect(placeholder).not.toBeNull();
    expect(placeholder?.getAttribute("contenteditable")).toBe("false");
    expect(placeholder?.textContent).toContain("co_table");
  });

  it("行内占位不接受选区施加的标记：所见即所存", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    editor.mount(host);

    editor.execute("selection.selectAll");
    editor.execute("format.bold");

    const mention = host.querySelector('[data-unknown-node="co_mention"]');
    expect(mention).not.toBeNull();
    expect(mention?.closest("strong")).toBeNull();
  });

  it("清标记是规范化而非用户编辑：撤销一次即回到加粗前", () => {
    const editor = createEditor();
    const loaded = JSON.parse(fixtureText);
    editor.loadDocument(loaded);
    editor.mount(host);

    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    expect(editor.undo().ok).toBe(true);

    expect(editor.getDocument().doc).toEqual(loaded.doc);
  });

  it("编辑其他内容后保存，未知节点子树仍然逐字节原样", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    editor.mount(host);

    editor.execute("selection.selectAll");
    editor.execute("format.bold");

    const original = JSON.parse(fixtureText).doc.content[1];
    expect(editor.getDocument().doc.content?.[1]).toEqual(original);
  });
});
