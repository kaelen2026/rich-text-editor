import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

describe("加粗命令", () => {
  it("选区跨越未加粗文本时不处于生效态，执行后整个选区生效，再执行一次取消", () => {
    const editor = createEditor();
    editor.loadDocument(JSON.parse(fixtureText));

    expect(editor.execute("selection.selectAll").ok).toBe(true);
    expect(editor.queryCommand("format.bold").active).toBe(false);

    expect(editor.execute("format.bold").ok).toBe(true);
    expect(editor.queryCommand("format.bold").active).toBe(true);

    expect(editor.execute("format.bold").ok).toBe(true);
    expect(editor.queryCommand("format.bold").active).toBe(false);
  });

  it("未注册的命令返回 disabled 而不是抛异常", () => {
    const editor = createEditor();

    const result = editor.execute("format.nonexistent");

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("disabled");
    expect(editor.queryCommand("format.nonexistent").enabled).toBe(false);
  });
});
