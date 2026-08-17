import type { NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { markdownToDocument } from "./parse";

/** 链接标记只在装了 link 插件时存在；解析测试自带一份最小规格。 */
const linkExtension = {
  marks: {
    co_link: {
      attrs: { href: {} },
      toDOM: () => ["a", 0] as const,
      fromMarkdown: [
        {
          token: "link",
          attrsFromToken: {
            href: {
              from: "attribute" as const,
              attribute: "href",
              type: "url" as const,
              protocols: ["https:", "http:", "mailto:", "tel:"],
            },
          },
        },
      ],
    },
  },
};

function blocks(markdown: string, extensions = {}): NodeJSON[] {
  return markdownToDocument(markdown, extensions).doc.content ?? [];
}

describe("Markdown 导入", () => {
  it("标题、段落、引用、分隔线各自落成对应节点", () => {
    expect(blocks("## 标题\n\n正文\n\n> 引用\n\n---\n")).toEqual([
      { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "标题" }] },
      { type: "paragraph", content: [{ type: "text", text: "正文" }] },
      {
        type: "blockquote",
        content: [{ type: "paragraph", content: [{ type: "text", text: "引用" }] }],
      },
      { type: "horizontal_rule" },
    ]);
  });

  it("h5 / h6 与外部 HTML 走同一条降级：归到 h4", () => {
    expect(blocks("##### 五级\n\n###### 六级\n").map((node) => node.attrs)).toEqual([
      { level: 4 },
      { level: 4 },
    ]);
  });

  it("围栏代码块读语言，非法语言当作没设置", () => {
    expect(blocks("```ts\nconst a = 1;\n```\n")).toEqual([
      {
        type: "code_block",
        attrs: { language: "ts" },
        content: [{ type: "text", text: "const a = 1;" }],
      },
    ]);
    expect(blocks("```<script>\nx\n```\n")[0]?.attrs).toEqual({ language: null });
  });

  it("有序列表读起始序号", () => {
    expect(blocks("3. 三\n4. 四\n")[0]?.attrs).toEqual({ start: 3 });
  });

  it("带复选框的列表整体转成待办列表，未勾选框的项按未完成收下", () => {
    const [list] = blocks("- [x] 完成\n- [ ] 未完成\n- 没有框\n");
    expect(list?.type).toBe("task_list");
    expect(list?.content?.map((item) => [item.type, item.attrs?.checked])).toEqual([
      ["task_item", true],
      ["task_item", false],
      ["task_item", false],
    ]);
    // 复选框本身不能留在正文里。
    expect(list?.content?.[0]?.content?.[0]?.content).toEqual([{ type: "text", text: "完成" }]);
  });

  it("没有复选框的列表仍是普通无序列表", () => {
    expect(blocks("- 一\n- 二\n")[0]?.type).toBe("bullet_list");
  });

  it("行内标记落成对应的 mark，行内代码带 code 标记", () => {
    const [paragraph] = blocks("**粗** *斜* ~~删~~ `码`\n");
    expect(paragraph?.content?.filter((node) => node.marks)).toEqual([
      { type: "text", text: "粗", marks: [{ type: "strong" }] },
      { type: "text", text: "斜", marks: [{ type: "em" }] },
      { type: "text", text: "删", marks: [{ type: "strikethrough" }] },
      { type: "text", text: "码", marks: [{ type: "code" }] },
    ]);
  });

  it("软换行落成硬换行，中文段落不会凭空多出一个空格", () => {
    expect(blocks("上一行\n下一行\n")[0]?.content).toEqual([
      { type: "text", text: "上一行" },
      { type: "hard_break" },
      { type: "text", text: "下一行" },
    ]);
  });

  it("空输入产出一个空段落，而不是不合法的空 doc", () => {
    expect(markdownToDocument("").doc).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});

describe("Markdown 导入的安全边界", () => {
  it("裸 HTML 按纯文本收下，不解析也不执行", () => {
    expect(blocks('<script>alert(1)</script>\n\n<div onclick="x">块</div>\n')).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "<script>alert(1)</script>" }] },
      { type: "paragraph", content: [{ type: "text", text: '<div onclick="x">块</div>' }] },
    ]);
  });

  it("javascript: 连链接语法都不成立，整段按字面量收下", () => {
    // markdown-it 自带的 `validateLink` 先拦一道：`javascript:` / `data:` /
    // `vbscript:` / `file:` 根本不会产出 link token。文字仍然一个不丢。
    const result = markdownToDocument("[点我](javascript:alert(1))\n", linkExtension);
    expect(result.doc.content?.[0]?.content).toEqual([
      { type: "text", text: "[点我](javascript:alert(1))" },
    ]);
  });

  it("markdown-it 放行、白名单不放行的协议丢标记留文字，并记一条降级", () => {
    // `ftp:` 过得了 markdown-it 那一关，过不了本项目的 https/http/mailto/tel
    // 白名单——两道判断各拦各的，这条用例钉的是第二道。
    const result = markdownToDocument("[下载](ftp://files.test/a.zip)\n", linkExtension);
    expect(result.doc.content?.[0]?.content).toEqual([{ type: "text", text: "下载" }]);
    expect(result.degrades).toEqual([
      expect.objectContaining({ kind: "unsafe-link", item: "co_link", count: 1 }),
    ]);
  });

  it("白名单内的链接正常落成 co_link", () => {
    expect(blocks("[站点](https://example.test/a)\n", linkExtension)[0]?.content).toEqual([
      {
        type: "text",
        text: "站点",
        marks: [{ type: "co_link", attrs: { href: "https://example.test/a" } }],
      },
    ]);
  });

  it("没装 link 插件时链接降级为纯文本，一个字不丢", () => {
    expect(blocks("[站点](https://example.test/a)\n")[0]?.content).toEqual([
      { type: "text", text: "站点" },
    ]);
  });

  it("图片降级为链接而不是直接写进 src——远端图片必须先服务端转存", () => {
    const result = markdownToDocument("![风景](https://img.test/a.png)\n", linkExtension);
    expect(result.doc.content?.[0]?.content).toEqual([
      {
        type: "text",
        text: "风景",
        marks: [{ type: "co_link", attrs: { href: "https://img.test/a.png" } }],
      },
    ]);
    expect(result.degrades).toEqual([
      expect.objectContaining({ kind: "image-as-link", item: "https://img.test/a.png" }),
    ]);
  });

  it("没有说明文字的图片用地址兜底，地址不会丢", () => {
    expect(blocks("![](https://img.test/a.png)\n", linkExtension)[0]?.content?.[0]?.text).toBe(
      "https://img.test/a.png",
    );
  });
});
