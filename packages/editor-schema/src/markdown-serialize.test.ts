import type { NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { documentToMarkdown } from "./markdown-serialize";

function doc(...content: NodeJSON[]): NodeJSON {
  return { type: "doc", content };
}

function paragraph(...content: NodeJSON[]): NodeJSON {
  return { type: "paragraph", content };
}

function text(value: string, ...marks: string[]): NodeJSON {
  return marks.length > 0
    ? { type: "text", text: value, marks: marks.map((type) => ({ type })) }
    : { type: "text", text: value };
}

describe("Markdown 导出", () => {
  it("块结构写成对应的 Markdown 语法", () => {
    expect(
      documentToMarkdown(
        doc(
          { type: "heading", attrs: { level: 2 }, content: [text("标题")] },
          paragraph(text("正文")),
          { type: "blockquote", content: [paragraph(text("引用")), paragraph(text("第二段"))] },
          { type: "horizontal_rule" },
        ),
      ),
    ).toBe("## 标题\n\n正文\n\n> 引用\n>\n> 第二段\n\n---\n");
  });

  it("行内标记按嵌套顺序包围，相邻同标记只包一次", () => {
    expect(
      documentToMarkdown(
        doc(
          paragraph(
            text("粗", "strong"),
            text("体", "strong"),
            text("　"),
            text("斜", "em"),
            text("删", "strikethrough"),
          ),
        ),
      ),
    ).toBe("**粗体**　*斜*~~删~~\n");
  });

  it("行内代码按内容加长围栏，代码块同理", () => {
    expect(documentToMarkdown(doc(paragraph(text("a ` b", "code"))))).toBe("``a ` b``\n");
    expect(
      documentToMarkdown(
        doc({
          type: "code_block",
          attrs: { language: "ts" },
          content: [text("const fence = '```';")],
        }),
      ),
    ).toBe("````ts\nconst fence = '```';\n````\n");
  });

  it("有序列表的续行缩进跟着序号宽度走", () => {
    expect(
      documentToMarkdown(
        doc({
          type: "ordered_list",
          attrs: { start: 9 },
          content: [
            { type: "list_item", content: [paragraph(text("九")), paragraph(text("续"))] },
            { type: "list_item", content: [paragraph(text("十"))] },
          ],
        }),
      ),
    ).toBe("9. 九\n\n   续\n10. 十\n");
  });

  it("待办列表把复选框写在列表标记之后", () => {
    expect(
      documentToMarkdown(
        doc({
          type: "task_list",
          content: [
            { type: "task_item", attrs: { checked: true }, content: [paragraph(text("做完了"))] },
            { type: "task_item", attrs: { checked: false }, content: [paragraph(text("没做"))] },
          ],
        }),
      ),
    ).toBe("- [x] 做完了\n- [ ] 没做\n");
  });

  it("嵌套列表按父列表的缩进宽度对齐", () => {
    expect(
      documentToMarkdown(
        doc({
          type: "bullet_list",
          content: [
            {
              type: "list_item",
              content: [
                paragraph(text("外层")),
                {
                  type: "bullet_list",
                  content: [{ type: "list_item", content: [paragraph(text("内层"))] }],
                },
              ],
            },
          ],
        }),
      ),
    ).toBe("- 外层\n\n  - 内层\n");
  });
});

describe("Markdown 转义", () => {
  it("只转义会被重新解析成结构的字符，中文标点原样保留", () => {
    expect(documentToMarkdown(doc(paragraph(text("成本是 3*4 元，见 [附录]。"))))).toBe(
      "成本是 3\\*4 元，见 \\[附录\\]。\n",
    );
  });

  it("词中间的下划线不转义，词边界上的转义", () => {
    expect(documentToMarkdown(doc(paragraph(text("snake_case_name 与 _强调_"))))).toBe(
      "snake_case_name 与 \\_强调\\_\n",
    );
  });

  it("行首的列表与标题标记被转义，行中间的同一字符不动", () => {
    expect(documentToMarkdown(doc(paragraph(text("- 这不是列表")), paragraph(text("a - b"))))).toBe(
      "\\- 这不是列表\n\na - b\n",
    );
    expect(documentToMarkdown(doc(paragraph(text("1. 这不是有序列表"))))).toBe(
      "1\\. 这不是有序列表\n",
    );
  });

  it("硬换行之后的一行同样按行首规则转义", () => {
    expect(
      documentToMarkdown(doc(paragraph(text("上"), { type: "hard_break" }, text("# 下")))),
    ).toBe("上\\\n\\# 下\n");
  });
});

describe("Markdown 表达不了的结构按丢格式不丢文字降级", () => {
  it("下划线、颜色标记与块对齐都只留下文字", () => {
    expect(
      documentToMarkdown(
        doc({
          type: "paragraph",
          attrs: { align: "center" },
          content: [
            text("下划线", "underline"),
            { type: "text", text: "有色", marks: [{ type: "co_text_color", attrs: {} }] },
          ],
        }),
        { marks: { co_text_color: { toDOM: () => ["span", 0] } } },
      ),
    ).toBe("下划线有色\n");
  });

  it("没有 Markdown 映射的节点接着渲染子节点，内容不消失", () => {
    expect(
      documentToMarkdown(
        doc({
          type: "co_callout",
          content: [paragraph(text("提示正文"))],
        }),
        { nodes: { co_callout: { content: "block+", toDOM: () => ["div", 0] } } },
      ),
    ).toBe("提示正文\n");
  });

  it("兜底节点导出 attrs.original 里的文字，而不是占位说明语", () => {
    expect(
      documentToMarkdown(
        doc({
          type: "unknown_block",
          attrs: {
            nodeName: "co_chart",
            original: {
              type: "co_chart",
              content: [{ type: "text", text: "季度营收 [见附件]" }],
            },
          },
        }),
      ),
    ).toBe("季度营收 \\[见附件\\]\n");
  });

  it("空文档导出成空字符串加换行", () => {
    expect(documentToMarkdown(doc(paragraph()))).toBe("\n");
  });
});
