// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { beforeEach, describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

function editableCount(host: HTMLElement): number {
  return host.querySelectorAll('[contenteditable="true"]').length;
}

describe("编辑器生命周期", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  it("mount 与 unmount 幂等且可重复配对，重挂载后文档内容不丢", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));

    editor.mount(host);
    expect(editableCount(host)).toBe(1);

    editor.mount(host);
    expect(editableCount(host)).toBe(1);

    editor.unmount();
    expect(editableCount(host)).toBe(0);
    editor.unmount();

    editor.mount(host);
    expect(editableCount(host)).toBe(1);
    expect(editor.getDocument().doc).toEqual(JSON.parse(fixtureText).doc);
  });

  it("卸载视图不销毁实例，文档仍可读写", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));
    editor.mount(host);
    editor.unmount();

    expect(editor.execute("selection.selectAll").ok).toBe(true);
    expect(editor.execute("format.bold").ok).toBe(true);
    expect(editor.queryCommand("format.bold").active).toBe(true);
  });

  it("destroy 之后命令返回 destroyed 而不是抛异常", () => {
    const editor = createEditor();
    editor.mount(host);

    editor.destroy();

    expect(editableCount(host)).toBe(0);
    expect(editor.execute("format.bold")).toEqual({ ok: false, reason: "destroyed" });
    expect(editor.queryCommand("format.bold").enabled).toBe(false);
  });
});
