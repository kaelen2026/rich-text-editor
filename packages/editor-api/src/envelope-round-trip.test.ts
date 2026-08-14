import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { stringifyEnvelope } from "@kaelen/editor-schema";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

describe("信封文档", () => {
  it("装载后取回的信封与磁盘上的字节完全一致", () => {
    const editor = createEditor();

    const result = editor.loadDocument(JSON.parse(fixtureText));

    expect(result.ok).toBe(true);
    expect(stringifyEnvelope(editor.getDocument())).toBe(fixtureText);
  });
});
