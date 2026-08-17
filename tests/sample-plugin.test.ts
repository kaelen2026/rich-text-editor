import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { createEmptyEnvelope } from "@kaelen/editor-schema";
import type { EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { CALLOUT_NODE, createSamplePlugin, HIGHLIGHT_MARK } from "./sample-plugin";

/**
 * 一致性测试（方案 §16.5）：新增一个能力插件不需要修改 Core 的私有实现。
 *
 * 断言分两层。一层是"它真的只用了公开 API"——靠读源文件的 import 判定，比任何
 * 约定都硬。另一层是"它真的能用"：装上之后节点、标记、命令、三种序列化表达和
 * 卸载后的兜底全都成立。
 */

const envelopeWith = (doc: NodeJSON): EditorEnvelope => ({ ...createEmptyEnvelope(), doc });

/**
 * 高亮标记刻意在提示框内外各出现一次：缺插件时两者走的是**不同**的兜底路径——
 * 框内的整块被包进 `unknown_block` 原样留存，框外的标记被丢掉只留文本。
 */
const sampleDocument = envelopeWith({
  type: "doc",
  content: [
    {
      type: CALLOUT_NODE,
      attrs: { tone: "warn" },
      content: [
        {
          type: "paragraph",
          attrs: { align: null },
          content: [
            { type: "text", text: "注意：" },
            { type: "text", text: "这一段高亮", marks: [{ type: HIGHLIGHT_MARK }] },
          ],
        },
      ],
    },
    {
      type: "paragraph",
      attrs: { align: null },
      content: [{ type: "text", text: "框外高亮", marks: [{ type: HIGHLIGHT_MARK }] }],
    },
  ],
});

describe("样例插件的一致性", () => {
  it("只 import 公开入口：没有深路径，也没有 ProseMirror", () => {
    const source = readFileSync(resolve(import.meta.dirname, "sample-plugin.ts"), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(([, value]) => value);

    expect(specifiers).toEqual(["@kaelen/editor-runtime"]);
    // 深路径是"改了 Core 私有实现"的最典型形态，单独钉一条。
    expect(source).not.toMatch(/@kaelen\/[a-z-]+\/src/);
    expect(source).not.toMatch(/prosemirror-/);
  });

  it("装上之后节点、标记与命令都可用", () => {
    const editor = createEditor({ plugins: [createSamplePlugin()] });
    expect(editor.loadDocument(sampleDocument).ok).toBe(true);

    // 插件贡献的结构版本进了信封，宿主据此判断需要什么才能完整编辑。
    expect(editor.getDocument().plugins.sample).toBe(1);

    // 选中全文后插件命令可用，且是开关语义：先补齐（选区里有没高亮的部分），
    // 再执行一次才是取消。这与核心格式命令 `toggleMark` 的语义一致。
    editor.execute("selection.selectAll");
    expect(editor.queryCommand("sample.toggleHighlight").enabled).toBe(true);
    expect(editor.execute("sample.toggleHighlight")).toEqual({ ok: true });
    expect(editor.queryCommand("sample.toggleHighlight").active).toBe(true);
    expect(editor.execute("sample.toggleHighlight")).toEqual({ ok: true });
    expect(editor.getHTML()).not.toContain("<mark>");
  });

  it("只读态：查询命令仍可用，会改文档的命令被如实拒绝", () => {
    // 新实例，光标停在文档开头——也就是提示框里面。
    const editor = createEditor({ plugins: [createSamplePlugin()] });
    editor.loadDocument(sampleDocument);
    editor.setMode("readonly");

    expect(editor.queryCommand("sample.insideCallout").enabled).toBe(true);
    expect(editor.execute("sample.toggleHighlight")).toEqual({
      ok: false,
      reason: "disabled",
      detail: "编辑器处于只读态",
    });
  });

  it("三种表达都由插件自带：HTML、Markdown 与 round-trip", () => {
    const editor = createEditor({ plugins: [createSamplePlugin()] });
    editor.loadDocument(sampleDocument);

    expect(editor.getHTML()).toBe(
      '<aside data-tone="warn"><p>注意：<mark>这一段高亮</mark></p></aside>' +
        "<p><mark>框外高亮</mark></p>",
    );
    expect(editor.getMarkdown()).toBe("> **warn**\n>\n> 注意：==这一段高亮==\n\n==框外高亮==\n");
    // 信封 round-trip 原样写回，否则插件的属性在保存时就丢了。
    expect(editor.getDocument().doc).toEqual(sampleDocument.doc);
  });

  it("不装这个插件时走 §9.3 兜底：结构原样留存，标记丢格式留文字", () => {
    const bare = createEditor();
    const result = bare.loadDocument(sampleDocument);

    expect(result.ok).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.unknownNodes).toEqual([CALLOUT_NODE]);
    expect(result.unknownMarks).toEqual([HIGHLIGHT_MARK]);

    const [callout, outside] = bare.getDocument().doc.content ?? [];
    // 整个提示框被收进兜底节点，保存时按 `attrs.original` 原样写回——因此这里
    // 拿到的就是原来那棵子树，装回插件重新打开一字不差。
    expect(callout).toEqual(sampleDocument.doc.content?.[0]);
    // 框外那条标记没有容身之处，按"丢标记保文本"处理。
    expect(outside).toEqual({
      type: "paragraph",
      attrs: { align: null },
      content: [{ type: "text", text: "框外高亮" }],
    });
  });

  it("命名空间违规由运行时拒绝，且报得出是谁和哪一项", () => {
    const editor = createEditor({
      plugins: [
        {
          name: "rogue",
          version: "1.0.0",
          namespace: "co_",
          extendSchema: (schema) => schema.addNode("callout", { group: "block" }),
        },
      ],
    });

    const [error] = editor.getPluginErrors();
    expect(error).toMatchObject({ plugin: "rogue", kind: "invalidName", item: "callout" });
    // 违规的是插件，不是编辑器：其余能力照常。
    expect(
      editor.loadDocument(envelopeWith({ type: "doc", content: [{ type: "paragraph" }] })).ok,
    ).toBe(true);
  });
});
