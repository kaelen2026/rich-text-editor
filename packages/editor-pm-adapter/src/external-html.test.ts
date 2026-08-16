import type { ResourcesOptions } from "jsdom";
import jsdom from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { parseExternalHTML } from "./external-html";
import { buildSchema } from "./schema";

const { JSDOM, requestInterceptor } = jsdom;

const schema = buildSchema({
  marks: {
    co_link: {
      attrs: { href: {} },
      parseDOM: [{ tag: "a", attrsFromDOM: { href: "href" } }],
      toDOM: () => ["a", 0],
    },
  },
});

describe("外部 HTML 粘贴", () => {
  it("仅从 inert document 解析：追踪图片不请求网络，危险内容不能进入文档", () => {
    const requests = vi.fn();
    usingDOM(
      () => {
        const slice = parseExternalHTML(
          schema,
          '<h6 onclick="alert(1)">标题</h6><p><a href="javascript:alert(1)">危险</a><img src="https://tracker.example/pixel.gif"></p><script>alert(1)</script>',
        );

        expect(slice.content.toJSON()).toEqual([
          {
            type: "heading",
            attrs: { level: 4, align: null },
            content: [{ type: "text", text: "标题" }],
          },
          {
            type: "paragraph",
            attrs: { align: null },
            content: [{ type: "text", text: "危险" }],
          },
        ]);
      },
      {
        interceptors: [
          requestInterceptor((request: Request) => {
            requests(request.url);
            return new Response("", { status: 200 });
          }),
        ],
      },
    );
    expect(requests).not.toHaveBeenCalled();
  });

  it("保留 schema 能表示的结构，拒绝相对和非白名单链接", () => {
    usingDOM(() => {
      const slice = parseExternalHTML(
        schema,
        '<ul><li><p><strong>粗体</strong> <a href="https://example.com/a">安全</a> <a href="/relative">相对</a></p></li></ul>',
      );

      expect(slice.content.toJSON()).toEqual([
        {
          type: "bullet_list",
          content: [
            {
              type: "list_item",
              content: [
                {
                  type: "paragraph",
                  attrs: { align: null },
                  content: [
                    { type: "text", marks: [{ type: "strong" }], text: "粗体" },
                    { type: "text", text: " " },
                    {
                      type: "text",
                      marks: [
                        {
                          type: "co_link",
                          attrs: { href: "https://example.com/a" },
                        },
                      ],
                      text: "安全",
                    },
                    { type: "text", text: " 相对" },
                  ],
                },
              ],
            },
          ],
        },
      ]);
    });
  });

  it("保留外部块的对齐，样式串本身不跟进文档", () => {
    usingDOM(() => {
      const slice = parseExternalHTML(
        schema,
        '<p style="text-align:center;color:red">居中</p>' +
          '<h2 align="RIGHT">标题</h2>' +
          '<p style="text-align:start">起始</p>' +
          '<p style="text-align:inherit">继承</p>' +
          '<p align="center;background:url(https://tracker.example)">伪造</p>',
      );

      expect(slice.content.toJSON()).toEqual([
        {
          type: "paragraph",
          attrs: { align: "center" },
          content: [{ type: "text", text: "居中" }],
        },
        {
          type: "heading",
          attrs: { level: 2, align: "right" },
          content: [{ type: "text", text: "标题" }],
        },
        { type: "paragraph", attrs: { align: "left" }, content: [{ type: "text", text: "起始" }] },
        { type: "paragraph", attrs: { align: null }, content: [{ type: "text", text: "继承" }] },
        { type: "paragraph", attrs: { align: null }, content: [{ type: "text", text: "伪造" }] },
      ]);
    });
  });

  it("将当前不支持的表格和未知块完整降级为段落文本", () => {
    usingDOM(() => {
      const slice = parseExternalHTML(
        schema,
        "<table><tbody><tr><td>甲</td><td>乙<script>不应保留</script></td></tr></tbody></table><section>丙 <span>丁</span></section>",
      );

      expect(slice.content.toJSON()).toEqual([
        { type: "paragraph", attrs: { align: null }, content: [{ type: "text", text: "甲乙" }] },
        { type: "paragraph", attrs: { align: null }, content: [{ type: "text", text: "丙 丁" }] },
      ]);
    });
  });

  it("fixtures 中的外部 HTML dump 与黄金 Schema JSON 一致", async () => {
    const fixturePath = resolve(
      import.meta.dirname,
      "../../../fixtures/clipboard/external-html.dump.txt",
    );
    const goldenPath = resolve(
      import.meta.dirname,
      "../../../fixtures/clipboard/external-html.golden.json",
    );
    const [html, golden] = await Promise.all([
      readFile(fixturePath, "utf8"),
      readFile(goldenPath, "utf8").then((value) => JSON.parse(value)),
    ]);

    usingDOM(() => {
      expect(parseExternalHTML(schema, html).content.toJSON()).toEqual(golden);
    });
  });
});

function usingDOM(run: () => void, resources?: ResourcesOptions): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    resources,
  });
  const oldDocument = globalThis.document;
  const oldDOMParser = globalThis.DOMParser;
  Object.assign(globalThis, {
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
  });
  try {
    run();
  } finally {
    Object.assign(globalThis, { document: oldDocument, DOMParser: oldDOMParser });
    dom.window.close();
  }
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
