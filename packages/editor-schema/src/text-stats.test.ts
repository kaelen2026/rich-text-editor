import type { NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { countDocumentText } from "./text-stats";

function doc(...content: NodeJSON[]): NodeJSON {
  return { type: "doc", content };
}

function paragraph(...text: string[]): NodeJSON {
  return { type: "paragraph", content: text.map((value) => ({ type: "text", text: value })) };
}

describe("字数统计", () => {
  it("CJK 一个字算一个字符，不按空格分词", () => {
    expect(countDocumentText(doc(paragraph("中文五个字")))).toEqual({
      characters: 5,
      charactersWithoutWhitespace: 5,
    });
  });

  it("emoji 序列、国旗与组合字符各算一个字", () => {
    // 依次是：ZWJ 家庭序列、国旗、e + 组合重音、带肤色的举手。
    expect(countDocumentText(doc(paragraph("👨‍👩‍👧🇨🇳é🙋🏽"))).characters).toBe(4);
  });

  it("空白进总数不进无空白口径", () => {
    expect(countDocumentText(doc(paragraph("a b\tc\nd")))).toEqual({
      characters: 7,
      charactersWithoutWhitespace: 4,
    });
  });

  it("跨块与跨标记的文本合并计数，块之间不补换行", () => {
    const document = doc(
      paragraph("一", "二"),
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "三" }] },
      paragraph("四"),
    );

    expect(countDocumentText(document).characters).toBe(4);
  });

  it("被标记切开的组合字符仍然算一个字", () => {
    expect(countDocumentText(doc(paragraph("e", "́"))).characters).toBe(1);
  });

  it("结构不产生字符：图片、分隔线、空表格都不计", () => {
    const document = doc(
      { type: "horizontal_rule" },
      { type: "co_image", attrs: { src: "https://example.com/a.png", alt: "很长的替代文本" } },
      paragraph("两个"),
    );

    expect(countDocumentText(document).characters).toBe(2);
  });

  it("兜底节点保存的原始子树不计入字数", () => {
    const document = doc({
      type: "unknown_block",
      attrs: {
        nodeName: "co_chart",
        original: { type: "co_chart", content: [{ type: "text", text: "不该被统计" }] },
      },
    });

    expect(countDocumentText(document).characters).toBe(0);
  });

  it("直接接受信封", () => {
    const envelope = {
      envelope: 1,
      schemaVersion: 1,
      plugins: {},
      doc: doc(paragraph("信封")),
      annotations: [],
    };

    expect(countDocumentText(envelope).characters).toBe(2);
  });
});
