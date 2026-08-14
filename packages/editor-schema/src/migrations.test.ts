import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { migrateDocument, schemaMigrations } from "./envelope";

const fixtures = resolve(import.meta.dirname, "../../../fixtures/migrations");

function readJSON<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(fixtures, name), "utf8")) as T;
}

describe("信封迁移链", () => {
  it("将裸 doc JSON 通过 0 → 1 迁移包装为当前信封，且不修改输入", () => {
    const legacy = readJSON<NodeJSON>("bare-doc.json");
    const before = structuredClone(legacy);

    const result = migrateDocument(legacy);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.migrated).toBe(true);
    expect(result.envelope).toEqual(readJSON<EditorEnvelope>("bare-doc.envelope.json"));
    expect(legacy).toEqual(before);
  });

  it("迁移中不改写未知节点及其整个子树", () => {
    const legacy = readJSON<NodeJSON>("bare-doc-with-unknown.json");

    const result = migrateDocument(legacy);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.envelope.doc).toEqual(legacy);
  });

  it("当前版本的信封不重复迁移", () => {
    const current = readJSON<EditorEnvelope>("bare-doc.envelope.json");

    const result = migrateDocument(current);

    expect(result).toEqual({ ok: true, migrated: false, envelope: current });
  });

  it("升级已有信封时保留插件版本并写出当前 schemaVersion", () => {
    const legacyEnvelope = {
      ...readJSON<EditorEnvelope>("bare-doc.envelope.json"),
      schemaVersion: 0,
      plugins: { table: 2 },
    };

    const result = migrateDocument(legacyEnvelope);

    expect(result).toEqual({
      ok: true,
      migrated: true,
      envelope: { ...legacyEnvelope, schemaVersion: 1 },
    });
  });

  it("拒绝比当前版本更新的文档", () => {
    const future = { ...readJSON<EditorEnvelope>("bare-doc.envelope.json"), schemaVersion: 2 };

    const result = migrateDocument(future);

    expect(result.ok).toBe(false);
  });

  it("将裸 doc 的包装步骤标记为不可逆", () => {
    expect(schemaMigrations).toEqual([
      expect.objectContaining({ from: 0, to: 1, reversible: false }),
    ]);
  });
});
