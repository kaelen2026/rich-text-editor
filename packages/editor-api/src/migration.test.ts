import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringifyEnvelope } from "@kaelen/editor-schema";
import type { NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { createEditor } from "./editor";

const fixtures = resolve(import.meta.dirname, "../../../fixtures/migrations");

function readJSON<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtures, name), "utf8")) as T;
}

describe("加载旧格式文档", () => {
  it("自动迁移裸 doc，并在保存时写出当前信封版本", () => {
    const editor = createEditor();

    const result = editor.loadDocument(readJSON<NodeJSON>("bare-doc.json"));

    expect(result).toMatchObject({ ok: true, migrated: true, degraded: false, unknownNodes: [] });
    expect(stringifyEnvelope(editor.getDocument())).toBe(
      readFileSync(resolve(fixtures, "bare-doc.envelope.json"), "utf8").trimEnd(),
    );
  });

  it("迁移后经未知节点兜底保存，未知子树仍原样存在", () => {
    const legacy = readJSON<NodeJSON>("bare-doc-with-unknown.json");
    const editor = createEditor();

    const result = editor.loadDocument(legacy);

    expect(result).toMatchObject({
      ok: true,
      migrated: true,
      degraded: true,
      unknownNodes: ["co_legacy_widget"],
    });
    expect(editor.getDocument().doc).toEqual(legacy);
  });
});
