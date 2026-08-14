// @vitest-environment jsdom
import { createEditor } from "@kaelen/editor-api";
import { describe, expect, it } from "vitest";
import { createLinkPlugin } from "./link-plugin";

const documentWithText = {
  envelope: 1,
  schemaVersion: 1,
  plugins: {},
  doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "官网" }] }] },
  annotations: [],
};

describe("链接插件", () => {
  it.each([
    "https://example.com",
    "http://example.com",
    "mailto:test@example.com",
    "tel:+8613800138000",
  ])("允许 %s 协议", (href) => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument(documentWithText);
    editor.execute("selection.selectAll");

    expect(editor.execute("link.set", { href })).toEqual({ ok: true });
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,evil",
    "vbscript:msgbox(1)",
    "/relative",
    "#fragment",
  ])("拒绝不安全或相对 URL：%s", (href) => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument(documentWithText);
    editor.execute("selection.selectAll");

    expect(editor.execute("link.set", { href })).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("只有安装插件的编辑器才能安全地设置、移除和读取链接", () => {
    const withoutPlugin = createEditor();
    expect(withoutPlugin.execute("link.set", { href: "https://example.com" })).toMatchObject({
      ok: false,
      reason: "disabled",
    });

    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument(documentWithText);
    editor.execute("selection.selectAll");

    expect(editor.execute("link.set", { href: "javascript:alert(1)" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(editor.execute("link.set", { href: "https://example.com/docs" })).toEqual({ ok: true });
    expect(editor.queryCommand("link.set")).toEqual({ enabled: true, active: true });
    expect(editor.execute("link.open")).toEqual({
      ok: true,
      detail: { href: "https://example.com/docs" },
    });

    expect(editor.getDocument().doc.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: "co_link", attrs: { href: "https://example.com/docs" } },
    ]);
    expect(editor.execute("link.unset")).toEqual({ ok: true });
    expect(editor.queryCommand("link.set")).toEqual({ enabled: true, active: false });
  });

  it("载入含链接标记的文档时不降级，并保留安全 URL", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    const result = editor.loadDocument({
      ...documentWithText,
      plugins: { link: 1 },
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "联系我",
                marks: [{ type: "co_link", attrs: { href: "mailto:test@example.com" } }],
              },
            ],
          },
        ],
      },
    });

    expect(result).toMatchObject({ ok: true, degraded: false, unknownNodes: [] });
    expect(editor.getDocument().doc.content?.[0]?.content?.[0]?.marks).toEqual([
      { type: "co_link", attrs: { href: "mailto:test@example.com" } },
    ]);
  });

  it("渲染链接时保留 href 并强制防 tabnabbing 的 rel", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument({
      ...documentWithText,
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "文档",
                marks: [{ type: "co_link", attrs: { href: "https://example.com/docs" } }],
              },
            ],
          },
        ],
      },
    });
    const host = document.createElement("div");
    editor.mount(host);

    const link = host.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});
