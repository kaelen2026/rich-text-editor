import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyDocumentPatch, buildSchema } from "@kaelen/editor-pm-adapter";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("DocumentPatch", () => {
  it("随机格式编辑序列重放后与直接编辑等价", () => {
    let seed = 0xdecafbad;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed;
    };
    const commands = ["format.bold", "format.italic", "format.underline", "format.strikethrough"];

    for (let run = 0; run < 20; run += 1) {
      const editor = createRuntime();
      editor.loadDocument(fixture);
      const patches: Parameters<typeof applyDocumentPatch>[2][] = [];
      editor.subscribe("patch", (patch) => patches.push(patch));
      editor.execute("selection.selectAll");
      for (let index = 0; index < 25; index += 1) {
        const command = commands[next() % commands.length];
        if (!command) throw new Error("missing random command");
        editor.execute(command);
      }

      let document = fixture.doc;
      let revision = 0;
      for (const patch of patches) {
        const replay = applyDocumentPatch(buildSchema(), document, patch, revision);
        expect(replay.ok).toBe(true);
        if (!replay.ok) throw new Error("patch should apply");
        document = replay.document;
        revision = replay.revision;
      }
      expect(document).toEqual(editor.getDocument().doc);
    }
  });

  it("把一次编辑的 patch 重放到同一基线，结果与直接编辑一致", () => {
    const editor = createRuntime();
    editor.loadDocument(fixture);
    const patches: Parameters<typeof applyDocumentPatch>[2][] = [];
    editor.subscribe("patch", (patch) => patches.push(patch));

    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    editor.execute("block.setHeading", { level: 2 });

    let document = fixture.doc;
    let revision = 0;
    for (const patch of patches) {
      const replay = applyDocumentPatch(buildSchema(), document, patch, revision);
      expect(replay.ok).toBe(true);
      if (!replay.ok) throw new Error("patch should apply");
      document = replay.document;
      revision = replay.revision;
    }

    expect(document).toEqual(editor.getDocument().doc);
    expect(revision).toBe(editor.getRevision());
  });

  it("逆变更按逆序重放后恢复原文档", () => {
    const editor = createRuntime();
    editor.loadDocument(fixture);
    const patches: Parameters<typeof applyDocumentPatch>[2][] = [];
    editor.subscribe("patch", (patch) => patches.push(patch));
    editor.execute("selection.selectAll");
    editor.execute("format.italic");

    const patch = patches[0];
    expect(patch).toBeDefined();
    if (!patch) throw new Error("missing patch");
    const changed = applyDocumentPatch(buildSchema(), fixture.doc, patch, 0);
    expect(changed.ok).toBe(true);
    if (!changed.ok) throw new Error("patch should apply");
    const restored = applyDocumentPatch(
      buildSchema(),
      changed.document,
      { ...patch, from: patch.to, to: patch.from, ops: patch.inverse, inverse: patch.ops },
      changed.revision,
    );

    expect(restored).toMatchObject({ ok: true, document: fixture.doc, revision: 0 });
  });

  it("拒绝过期 revision，调用方必须先重放缺失 patch", () => {
    const editor = createRuntime();
    editor.loadDocument(fixture);
    const patches: Parameters<typeof applyDocumentPatch>[2][] = [];
    editor.subscribe("patch", (patch) => patches.push(patch));
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    const patch = patches[0];
    expect(patch).toBeDefined();
    if (!patch) throw new Error("missing patch");

    expect(applyDocumentPatch(buildSchema(), fixture.doc, patch, 4)).toEqual({
      ok: false,
      reason: "revision-mismatch",
      expectedRevision: 4,
    });
  });

  it("2 秒空闲时自动保存，50 次变更时立即保存", () => {
    vi.useFakeTimers();
    const save = vi.fn();
    const editor = createRuntime({ autoSave: { onSave: save } });
    editor.loadDocument(fixture);

    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    vi.advanceTimersByTime(1999);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ revision: 1 }));

    for (let index = 0; index < 50; index += 1) {
      editor.execute(index % 2 === 0 ? "format.italic" : "format.bold");
    }
    expect(save).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
