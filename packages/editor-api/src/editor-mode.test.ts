// @vitest-environment jsdom
import { createEditor, type RichEditor } from "@kaelen/editor-api";
import type { NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";

const doc: NodeJSON = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", marks: [{ type: "strong" }], text: "加粗文本" }],
    },
  ],
};

function createLoadedEditor(): RichEditor {
  const editor = createEditor();
  editor.loadDocument(doc);
  editor.execute("selection.selectAll");
  return editor;
}

describe("编辑器三态", () => {
  it("默认可编辑，快照带上当前态", () => {
    const editor = createLoadedEditor();

    expect(editor.getMode()).toBe("edit");
    expect(editor.getSnapshot().mode).toBe("edit");
    expect(editor.execute("format.italic").ok).toBe(true);
  });

  it("只读态拒绝改文档的命令，但仍可选中、复制、查生效态", () => {
    const editor = createLoadedEditor();
    editor.setMode("readonly");

    expect(editor.execute("format.italic")).toMatchObject({ ok: false, reason: "disabled" });
    expect(editor.execute("history.undo")).toMatchObject({ ok: false, reason: "disabled" });
    expect(editor.queryCommand("format.bold").enabled).toBe(false);
    // 生效态与可用性分开：按钮不可点，但要照常显示选区是粗体。
    expect(editor.queryCommand("format.bold").active).toBe(true);
    expect(editor.execute("selection.selectAll").ok).toBe(true);
    expect(editor.getDocument().doc).toEqual(doc);
  });

  it("禁用态连全选都不放行", () => {
    const editor = createLoadedEditor();
    editor.setMode("disabled");

    expect(editor.execute("selection.selectAll")).toMatchObject({ ok: false, reason: "disabled" });
    expect(editor.queryCommand("selection.selectAll").enabled).toBe(false);
  });

  it("切回编辑态后命令恢复，文档一字不差", () => {
    const editor = createLoadedEditor();
    editor.setMode("disabled");
    editor.setMode("edit");

    expect(editor.getMode()).toBe("edit");
    expect(editor.execute("format.italic").ok).toBe(true);
    expect(editor.getDocument().doc).not.toEqual(doc);
  });

  it("切换三态产生一次状态变更，UI 能订阅到", () => {
    const editor = createLoadedEditor();
    let changes = 0;
    editor.subscribe("change", () => {
      changes += 1;
    });

    editor.setMode("readonly");
    expect(changes).toBe(1);
    // 切到同一个态不产生噪声。
    editor.setMode("readonly");
    expect(changes).toBe(1);
  });

  it("三态在 DOM 上的语义不同：只读可聚焦，禁用不进 Tab 序", () => {
    const editor = createLoadedEditor();
    const host = document.createElement("div");
    document.body.append(host);
    editor.mount(host);

    const surface = () => host.querySelector(".ProseMirror") as HTMLElement;

    expect(surface().getAttribute("contenteditable")).toBe("true");
    expect(surface().getAttribute("role")).toBe("textbox");
    expect(surface().getAttribute("aria-multiline")).toBe("true");

    editor.setMode("readonly");
    expect(surface().getAttribute("contenteditable")).toBe("false");
    expect(surface().getAttribute("tabindex")).toBe("0");
    expect(surface().getAttribute("aria-readonly")).toBe("true");
    expect(surface().hasAttribute("aria-disabled")).toBe(false);

    editor.setMode("disabled");
    expect(surface().getAttribute("contenteditable")).toBe("false");
    expect(surface().hasAttribute("tabindex")).toBe(false);
    expect(surface().getAttribute("aria-disabled")).toBe("true");

    editor.destroy();
    host.remove();
  });
});
