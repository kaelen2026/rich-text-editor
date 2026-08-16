// @vitest-environment jsdom
import { createEditor } from "@kaelen/editor-api";
import type { EditorEnvelope } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { createColorPlugin } from "./color-plugin";

const documentWithText: EditorEnvelope = {
  envelope: 1,
  schemaVersion: 1,
  plugins: {},
  doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "标题" }] }] },
  annotations: [],
};

function editorWithSelection() {
  const editor = createEditor({ plugins: [createColorPlugin()] });
  editor.loadDocument(documentWithText);
  editor.execute("selection.selectAll");
  return editor;
}

function marksOfFirstText(editor: ReturnType<typeof createEditor>) {
  return editor.getDocument().doc.content?.[0]?.content?.[0]?.marks;
}

describe("颜色插件", () => {
  it.each(["#f00", "#FF0000", " #ff0000 ", "#0a0b0c", "#f00c", "#ff0000cc"])(
    "接受十六进制颜色 %s",
    (color) => {
      const editor = editorWithSelection();
      expect(editor.execute("color.setText", { color })).toEqual({ ok: true });
    },
  );

  it.each([
    "red",
    "rgb(255, 0, 0)",
    "var(--brand)",
    "#gggggg",
    "#ff000",
    "red; background: url(https://evil.example)",
    "url(javascript:alert(1))",
    "",
  ])("拒绝非十六进制或可注入的颜色值：%s", (color) => {
    const editor = editorWithSelection();
    expect(editor.execute("color.setText", { color })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(editor.execute("color.setBackground", { color })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("前景色与背景色互不覆盖，可同时生效", () => {
    const editor = editorWithSelection();

    expect(editor.execute("color.setText", { color: "#ff0000" })).toEqual({ ok: true });
    expect(editor.execute("color.setBackground", { color: "#ffff00" })).toEqual({ ok: true });

    expect(marksOfFirstText(editor)).toEqual([
      { type: "co_text_color", attrs: { color: "#ff0000" } },
      { type: "co_background_color", attrs: { color: "#ffff00" } },
    ]);
  });

  it("重复设置是换颜色而不是取消，颜色值统一小写存储", () => {
    const editor = editorWithSelection();
    editor.execute("color.setText", { color: "#FF0000" });

    expect(editor.execute("color.setText", { color: "#0000FF" })).toEqual({ ok: true });
    expect(marksOfFirstText(editor)).toEqual([
      { type: "co_text_color", attrs: { color: "#0000ff" } },
    ]);
  });

  it("生效态区分具体颜色，取消后回到无色", () => {
    const editor = editorWithSelection();
    editor.execute("color.setText", { color: "#ff0000" });

    expect(editor.queryCommand("color.setText", { color: "#ff0000" })).toEqual({
      enabled: true,
      active: true,
    });
    expect(editor.queryCommand("color.setText", { color: "#0000ff" })).toEqual({
      enabled: true,
      active: false,
    });
    expect(editor.queryCommand("color.unsetText")).toEqual({ enabled: true, active: true });

    expect(editor.execute("color.unsetText")).toEqual({ ok: true });
    expect(marksOfFirstText(editor)).toBeUndefined();
    expect(editor.queryCommand("color.unsetText")).toEqual({ enabled: false, active: false });
    expect(editor.execute("color.unsetText")).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("光标态没有可上色的范围，命令不可用", () => {
    const editor = createEditor({ plugins: [createColorPlugin()] });
    editor.loadDocument(documentWithText);

    expect(editor.queryCommand("color.setText", { color: "#ff0000" })).toEqual({
      enabled: false,
      active: false,
    });
    expect(editor.execute("color.setBackground", { color: "#ff0000" })).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("没装插件时命令不存在，文档里的颜色标记降级为纯文本且有记录", () => {
    const editor = createEditor();
    expect(editor.execute("color.setText", { color: "#ff0000" })).toMatchObject({
      ok: false,
      reason: "disabled",
    });

    const result = editor.loadDocument(coloredDocument("#ff0000"));
    expect(result.unknownMarks).toEqual(["co_text_color"]);
    expect(marksOfFirstText(editor)).toBeUndefined();
    expect(editor.getDocument().doc.content?.[0]?.content?.[0]?.text).toBe("标题");
  });

  it("渲染时把颜色写进 style，并附带可回解析的数据属性", () => {
    const editor = createEditor({ plugins: [createColorPlugin()] });
    editor.loadDocument(coloredDocument("#f00"));
    const host = document.createElement("div");
    editor.mount(host);

    const span = host.querySelector<HTMLElement>("span[data-co-text-color]");
    expect(span?.style.color).toBe("rgb(255, 0, 0)");
    // 数据属性保留十六进制：那是文档里的规范形态，也是解析回来的依据。
    expect(span?.getAttribute("data-co-text-color")).toBe("#f00");
    expect(editor.getHTML()).toContain(
      '<span data-co-text-color="#f00" style="color: rgb(255, 0, 0);">标题</span>',
    );
  });

  it("服务端渲染与浏览器落进 DOM 的 style 字节相同", () => {
    const editor = createEditor({ plugins: [createColorPlugin()] });
    editor.loadDocument(coloredDocument("#d92d20"));
    const host = document.createElement("div");
    editor.mount(host);

    const span = host.querySelector<HTMLElement>("span[data-co-text-color]");
    expect(span?.getAttribute("style")).toBe("color: rgb(217, 45, 32);");
    expect(editor.getHTML()).toContain('style="color: rgb(217, 45, 32);"');
  });

  it("带透明度的颜色渲染成 rgba，不透明的仍是 rgb", () => {
    const editor = editorWithSelection();
    editor.execute("color.setBackground", { color: "#fef08acc" });

    const host = document.createElement("div");
    editor.mount(host);
    const span = host.querySelector<HTMLElement>("span[data-co-background-color]");
    // 浏览器把 alpha=1 的 rgba 写回 rgb()，两侧字节一致要求服务端也这么产出。
    expect(span?.getAttribute("style")).toBe("background-color: rgba(254, 240, 138, 0.8);");
    expect(editor.getHTML()).toContain('style="background-color: rgba(254, 240, 138, 0.8);"');
  });

  it("不透明度写满时与不带 alpha 的颜色渲染成同一个声明", () => {
    const editor = editorWithSelection();
    editor.execute("color.setText", { color: "#ff0000ff" });

    expect(editor.getHTML()).toContain('style="color: rgb(255, 0, 0);"');
  });

  it("读取命令回报选区当前的颜色，没有颜色时不可用", () => {
    const editor = editorWithSelection();

    expect(editor.execute("color.readText")).toMatchObject({ ok: false, reason: "disabled" });

    editor.execute("color.setText", { color: "#d92d20" });
    editor.execute("color.setBackground", { color: "#fef08acc" });

    expect(editor.execute("color.readText")).toEqual({ ok: true, detail: { color: "#d92d20" } });
    expect(editor.execute("color.readBackground")).toEqual({
      ok: true,
      detail: { color: "#fef08acc" },
    });
  });

  it("背景色渲染成 background-color", () => {
    const editor = editorWithSelection();
    editor.execute("color.setBackground", { color: "#ffff00" });

    expect(editor.getHTML()).toContain(
      '<span data-co-background-color="#ffff00" style="background-color: rgb(255, 255, 0);">标题</span>',
    );
  });

  it("文档里被改坏的颜色值渲染时被丢弃，文本照常显示", () => {
    const editor = createEditor({ plugins: [createColorPlugin()] });
    editor.loadDocument(coloredDocument("red; background: url(https://evil.example)"));

    const html = editor.getHTML();
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("style=");
    expect(html).toContain("标题");
  });
});

function coloredDocument(color: string): EditorEnvelope {
  return {
    ...documentWithText,
    plugins: { color: 1 },
    doc: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "标题", marks: [{ type: "co_text_color", attrs: { color } }] },
          ],
        },
      ],
    },
  };
}
