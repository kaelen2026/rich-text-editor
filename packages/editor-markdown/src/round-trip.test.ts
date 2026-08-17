import { createEditor, type RichEditor } from "@kaelen/editor-api";
import { createColorPlugin } from "@kaelen/editor-plugin-color";
import { createImagePlugin } from "@kaelen/editor-plugin-image";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { createTablePlugin } from "@kaelen/editor-plugin-table";
import { createEmptyEnvelope } from "@kaelen/editor-schema";
import type { NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { markdownToDocument } from "./parse";

function newEditor(): RichEditor {
  return createEditor({
    plugins: [
      createLinkPlugin(),
      createTablePlugin(),
      createColorPlugin(),
      createImagePlugin({
        uploader: {
          upload: async () => {
            throw new Error("round-trip 测试不上传");
          },
        },
      }),
    ],
  });
}

/** 装载一次让 Schema 补齐默认属性，两侧才在同一口径上比较。 */
function normalize(doc: NodeJSON): NodeJSON {
  const editor = newEditor();
  const result = editor.loadDocument({ ...createEmptyEnvelope(), doc });
  expect(result.ok).toBe(true);
  return editor.getDocument().doc;
}

/** 文档 → Markdown → 文档。 */
function roundTrip(doc: NodeJSON): { markdown: string; doc: NodeJSON } {
  const editor = newEditor();
  expect(editor.loadDocument({ ...createEmptyEnvelope(), doc }).ok).toBe(true);
  const markdown = editor.getMarkdown();
  const imported = markdownToDocument(markdown, editor.getSchemaExtensions());
  return { markdown, doc: normalize(imported.doc) };
}

const text = (value: string, ...marks: string[]): NodeJSON =>
  marks.length > 0
    ? { type: "text", text: value, marks: marks.map((type) => ({ type })) }
    : { type: "text", text: value };
const paragraph = (...content: NodeJSON[]): NodeJSON => ({ type: "paragraph", content });
const cell = (type: string, value: string): NodeJSON => ({
  type,
  content: [paragraph(text(value))],
});

/**
 * Markdown 表达得了的全部结构。这一份 fixture 的作用是"改坏了会被发现"：
 * 序列化和解析各自单测能过、合起来不闭环的情况，只有 round-trip 抓得住。
 */
const expressible: NodeJSON = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [text("季度小结")] },
    paragraph(
      text("这一段有"),
      text("粗体", "strong"),
      text("、"),
      text("斜体", "em"),
      text("、"),
      text("删除线", "strikethrough"),
      text("和"),
      text("inline_code()", "code"),
      text("，还有一个"),
      {
        type: "text",
        text: "链接",
        marks: [{ type: "co_link", attrs: { href: "https://example.test/a?x=1&y=2" } }],
      },
      text("。"),
    ),
    { type: "blockquote", content: [paragraph(text("引用第一段")), paragraph(text("引用第二段"))] },
    {
      type: "bullet_list",
      content: [
        {
          type: "list_item",
          content: [
            paragraph(text("外层项")),
            {
              type: "bullet_list",
              content: [{ type: "list_item", content: [paragraph(text("嵌套项"))] }],
            },
          ],
        },
        { type: "list_item", content: [paragraph(text("第二项"))] },
      ],
    },
    {
      type: "ordered_list",
      attrs: { start: 3 },
      content: [
        { type: "list_item", content: [paragraph(text("第三"))] },
        { type: "list_item", content: [paragraph(text("第四"))] },
      ],
    },
    {
      type: "task_list",
      content: [
        { type: "task_item", attrs: { checked: true }, content: [paragraph(text("已完成"))] },
        { type: "task_item", attrs: { checked: false }, content: [paragraph(text("待办"))] },
      ],
    },
    {
      type: "code_block",
      attrs: { language: "ts" },
      content: [text("const value = `模板`;\nexport default value;")],
    },
    { type: "horizontal_rule" },
    paragraph(text("换行前"), { type: "hard_break" }, text("换行后")),
    {
      type: "co_table",
      content: [
        {
          type: "co_table_row",
          content: [cell("co_table_header", "指标"), cell("co_table_header", "数值")],
        },
        {
          type: "co_table_row",
          content: [cell("co_table_cell", "营收"), cell("co_table_cell", "1024")],
        },
      ],
    },
    paragraph(text("含 * 星号、_ 下划线、[方括号] 与 | 竖线的正文，中文标点：不该被转义。")),
  ],
};

describe("Markdown 往返", () => {
  it("Markdown 表达得了的结构往返后与原文档全等", () => {
    expect(roundTrip(expressible).doc).toEqual(normalize(expressible));
  });

  it("往返两次稳定：第二次导出与第一次逐字节相同", () => {
    const first = roundTrip(expressible);
    const second = roundTrip(first.doc);
    expect(second.markdown).toBe(first.markdown);
  });
});

describe("Markdown 表达不了的结构：丢格式，不丢文字", () => {
  it("颜色、下划线与块对齐在往返后消失，文字与结构还在", () => {
    const styled: NodeJSON = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          attrs: { align: "center" },
          content: [
            text("下划线", "underline"),
            {
              type: "text",
              text: "红字",
              marks: [{ type: "co_text_color", attrs: { color: "#d92d20" } }],
            },
          ],
        },
      ],
    };
    expect(roundTrip(styled).doc).toEqual(
      normalize({ type: "doc", content: [paragraph(text("下划线红字"))] }),
    );
  });

  it("图片往返成链接，地址与替代文本都在，并留下降级记录", () => {
    const editor = newEditor();
    editor.loadDocument({
      ...createEmptyEnvelope(),
      doc: {
        type: "doc",
        content: [
          {
            type: "co_image",
            attrs: { src: "https://assets.test/a.png", alt: "示意图", displayWidth: 320 },
          },
        ],
      },
    });
    const markdown = editor.getMarkdown();
    expect(markdown).toBe("![示意图](https://assets.test/a.png)\n");

    const imported = markdownToDocument(markdown, editor.getSchemaExtensions());
    expect(imported.degrades).toEqual([
      expect.objectContaining({ kind: "image-as-link", item: "https://assets.test/a.png" }),
    ]);
    expect(imported.doc.content?.[0]?.content).toEqual([
      {
        type: "text",
        text: "示意图",
        marks: [{ type: "co_link", attrs: { href: "https://assets.test/a.png" } }],
      },
    ]);
  });

  it("合并单元格摊平成占位网格，列不错位，文字一个不少", () => {
    const editor = newEditor();
    editor.loadDocument({
      ...createEmptyEnvelope(),
      doc: {
        type: "doc",
        content: [
          {
            type: "co_table",
            content: [
              {
                type: "co_table_row",
                content: [
                  { ...cell("co_table_header", "跨两列"), attrs: { colspan: 2 } },
                  cell("co_table_header", "第三列"),
                ],
              },
              {
                type: "co_table_row",
                content: [
                  cell("co_table_cell", "a"),
                  cell("co_table_cell", "b"),
                  cell("co_table_cell", "c"),
                ],
              },
            ],
          },
        ],
      },
    });
    // 跨两列的表头占掉第 1、2 列，第三列因此仍然落在第 3 列上。
    expect(editor.getMarkdown()).toBe(
      "| 跨两列 |  | 第三列 |\n| --- | --- | --- |\n| a | b | c |\n",
    );
  });

  it("跨行合并同样按占位网格排，下一行不会被顶掉一格", () => {
    const editor = newEditor();
    editor.loadDocument({
      ...createEmptyEnvelope(),
      doc: {
        type: "doc",
        content: [
          {
            type: "co_table",
            content: [
              {
                type: "co_table_row",
                content: [
                  { ...cell("co_table_header", "跨两行"), attrs: { rowspan: 2 } },
                  cell("co_table_header", "右上"),
                ],
              },
              { type: "co_table_row", content: [cell("co_table_cell", "右下")] },
            ],
          },
        ],
      },
    });
    expect(editor.getMarkdown()).toBe("| 跨两行 | 右上 |\n| --- | --- |\n|  | 右下 |\n");
  });

  it("没装表格插件时表格导出成单元格文字，内容不消失", () => {
    const editor = createEditor();
    editor.loadDocument({
      ...createEmptyEnvelope(),
      doc: {
        type: "doc",
        content: [
          {
            type: "co_table",
            content: [
              {
                type: "co_table_row",
                content: [cell("co_table_cell", "缺插件也要读得到")],
              },
            ],
          },
        ],
      },
    });
    // 装载时走 §9.3 兜底成 unknown_block，导出取的是 attrs.original 里的文字。
    expect(editor.getMarkdown()).toBe("缺插件也要读得到\n");
  });
});
