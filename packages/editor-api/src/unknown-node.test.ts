import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { stringifyEnvelope } from "@kaelen/editor-schema";
import type { EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-with-unknown.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();
const basicPath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const basicText = readFileSync(basicPath, "utf8").trimEnd();

function envelopeWith(doc: NodeJSON): EditorEnvelope {
  return { envelope: 1, schemaVersion: 1, plugins: {}, doc, annotations: [] };
}

describe("未知节点兜底", () => {
  it("缺少对应插件时仍能装载，且取回的信封与磁盘字节一致", () => {
    const editor = createEditor();

    const result = editor.loadDocument(JSON.parse(fixtureText));

    expect(result.ok).toBe(true);
    expect(stringifyEnvelope(editor.getDocument())).toBe(fixtureText);
  });

  it("装载时报告降级内容并派发 documentDegraded", () => {
    const editor = createEditor();
    let degradedEvents = 0;
    editor.subscribe("documentDegraded", () => {
      degradedEvents += 1;
    });

    const result = editor.loadDocument(JSON.parse(fixtureText));

    expect(result.degraded).toBe(true);
    expect(result.unknownNodes).toEqual(["co_table", "co_mention"]);
    expect(degradedEvents).toBe(1);
  });

  it("同一种未知节点出现多次只报告一次", () => {
    const editor = createEditor();
    const doc = {
      type: "doc",
      content: [
        { type: "co_embed", attrs: { url: "a" } },
        { type: "co_embed", attrs: { url: "b" } },
      ],
    };

    const result = editor.loadDocument(envelopeWith(doc));

    expect(result.unknownNodes).toEqual(["co_embed"]);
  });

  it("未知标记被丢弃但它覆盖的文本保留", () => {
    const editor = createEditor();
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              marks: [{ type: "co_highlight", attrs: { color: "red" } }, { type: "strong" }],
              text: "重要文本",
            },
          ],
        },
      ],
    };

    expect(editor.loadDocument(envelopeWith(doc)).ok).toBe(true);

    const textNode = editor.getDocument().doc.content?.[0]?.content?.[0];
    expect(textNode?.text).toBe("重要文本");
    expect(textNode?.marks).toEqual([{ type: "strong" }]);
  });

  it("全部节点已知时不报告降级也不派发事件", () => {
    const editor = createEditor();
    let degradedEvents = 0;
    editor.subscribe("documentDegraded", () => {
      degradedEvents += 1;
    });

    const result = editor.loadDocument(JSON.parse(basicText));

    expect(result.degraded).toBe(false);
    expect(result.unknownNodes).toEqual([]);
    expect(degradedEvents).toBe(0);
  });
});
