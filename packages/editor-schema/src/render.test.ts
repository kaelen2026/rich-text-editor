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
