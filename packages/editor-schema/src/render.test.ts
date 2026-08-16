import { describe, expect, it } from "vitest";
import { renderDocumentToHTML } from "./render";

describe("无 DOM 的 HTML 渲染", () => {
  it("转义文本和属性，并把内容放进 DOMOutputSpec 的内容孔", () => {
    expect(
      renderDocumentToHTML(
        {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  marks: [{ type: "co_link", attrs: { href: "https://example.com/?a=1&b=2" } }],
                  text: "<安全>&",
                },
              ],
            },
          ],
        },
        {
          marks: {
            co_link: {
              toDOM: (mark) => ["a", { href: String(mark.attrs.href), rel: "noopener" }, 0],
            },
          },
        },
      ),
    ).toBe(
      '<p><a href="https://example.com/?a=1&amp;b=2" rel="noopener">&lt;安全&gt;&amp;</a></p>',
    );
  });

  it("对齐同时输出内联样式与 data 属性，没设置时输出与从前一致", () => {
    expect(
      renderDocumentToHTML({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { align: "center" },
            content: [{ type: "text", text: "居中" }],
          },
          {
            type: "heading",
            attrs: { level: 2, align: "justify" },
            content: [{ type: "text", text: "标题" }],
          },
          { type: "paragraph", attrs: { align: null }, content: [{ type: "text", text: "默认" }] },
        ],
      }),
    ).toBe(
      '<p style="text-align:center" data-align="center">居中</p>' +
        '<h2 style="text-align:justify" data-align="justify">标题</h2>' +
        "<p>默认</p>",
    );
  });

  it("伪造的对齐值不进内联样式", () => {
    expect(
      renderDocumentToHTML({
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: { align: "center;background:url(https://tracker.example)" },
            content: [{ type: "text", text: "文本" }],
          },
        ],
      }),
    ).toBe("<p>文本</p>");
  });

  it("没有安装对应 Schema 的节点只输出只读占位，不解释其原始内容", () => {
    expect(
      renderDocumentToHTML({
        type: "doc",
        content: [{ type: "co_embed", attrs: { html: "<script>alert(1)</script>" } }],
      }),
    ).toBe(
      '<span data-unknown-node="co_embed" class="co-unknown" contenteditable="false">此内容需要「co_embed」功能才能显示与编辑</span>',
    );
  });
});
