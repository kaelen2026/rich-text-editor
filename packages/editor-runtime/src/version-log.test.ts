import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  appendVersionLogEntry,
  applyDocumentPatch,
  buildSchema,
  createVersionLog,
  documentAtRevision,
  inverseOpsBetween,
  versionLogTip,
} from "@kaelen/editor-pm-adapter";
import type { DocumentPatch, NodeJSON, VersionLog } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "./runtime";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

/** 一个装载了基线文档、把 patch 流累积进版本日志的运行时。 */
function editingSession(): {
  editor: Runtime;
  log: () => VersionLog;
  snapshots: NodeJSON[];
} {
  const editor = createRuntime();
  editor.loadDocument(fixture);
  let log = createVersionLog(fixture.doc, 0);
  const snapshots: NodeJSON[] = [fixture.doc];
  editor.subscribe("patch", (patch: DocumentPatch) => {
    const appended = appendVersionLogEntry(log, patch);
    expect(appended.ok).toBe(true);
    if (appended.ok) {
      log = appended.log;
    }
    snapshots.push(JSON.parse(JSON.stringify(editor.getDocument().doc)) as NodeJSON);
  });
  return { editor, log: () => log, snapshots };
}

describe("版本日志：按 patch 累积版本", () => {
  it("连续追加通过，修订号断开的 patch 被拒绝", () => {
    const { editor, log } = editingSession();
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    editor.execute("format.italic");
    expect(versionLogTip(log())).toBe(2);

    const stale: DocumentPatch = { v: 1, from: 0, to: 1, ops: [], inverse: [] };
    const rejected = appendVersionLogEntry(log(), stale);
    expect(rejected).toEqual({ ok: false, reason: "revision-mismatch", expectedRevision: 2 });
  });

  it("documentAtRevision 能还原任意历史版本（含基线与最新）", () => {
    const { editor, log, snapshots } = editingSession();
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    editor.execute("block.setHeading", { level: 2 });
    editor.execute("format.underline");

    const schema = buildSchema();
    for (let revision = 0; revision <= versionLogTip(log()); revision += 1) {
      const at = documentAtRevision(schema, log(), revision);
      expect(at.ok).toBe(true);
      if (at.ok) {
        expect(at.document).toEqual(snapshots[revision]);
      }
    }
  });

  it("基线之前或未来的版本号返回错误而不是猜", () => {
    const { editor, log } = editingSession();
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    const schema = buildSchema();
    expect(documentAtRevision(schema, log(), -1).ok).toBe(false);
    expect(documentAtRevision(schema, log(), 99).ok).toBe(false);
    const offBase: VersionLog = { ...log(), baseRevision: 5 };
    expect(documentAtRevision(schema, offBase, 3).ok).toBe(false);
  });

  it("属性：随机编辑序列后，任意跨版本区间的重放与当时的快照全等", () => {
    let seed = 0x5eed5;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      return seed;
    };
    const commands = ["format.bold", "format.italic", "format.underline", "format.strikethrough"];
    const { editor, log, snapshots } = editingSession();
    editor.execute("selection.selectAll");
    for (let index = 0; index < 30; index += 1) {
      const command = commands[next() % commands.length];
      if (!command) throw new Error("missing random command");
      editor.execute(command);
    }
    const schema = buildSchema();
    for (let round = 0; round < 10; round += 1) {
      const revision = next() % (versionLogTip(log()) + 1);
      const at = documentAtRevision(schema, log(), revision);
      expect(at.ok).toBe(true);
      if (at.ok) {
        expect(at.document).toEqual(snapshots[revision]);
      }
    }
  });

  it("inverseOpsBetween 给出的逆变更把新版本改回旧版本", () => {
    const { editor, log, snapshots } = editingSession();
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    editor.execute("block.setHeading", { level: 3 });
    editor.execute("format.strikethrough");

    const schema = buildSchema();
    const ops = inverseOpsBetween(log(), 3, 1);
    expect(ops).not.toBeNull();
    // 把逆变更包成一条 patch 重放：结果应与版本 1 的快照全等。
    const restore: DocumentPatch = { v: 1, from: 3, to: 4, ops: ops ?? [], inverse: [] };
    const target = snapshots[3];
    if (!target) throw new Error("缺少快照");
    const replayBase = JSON.parse(JSON.stringify(target)) as NodeJSON;
    const replay = applyDocumentPatch(schema, replayBase, restore, 3);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.document).toEqual(snapshots[1]);
    }
  });

  it("同一区间两端相同或方向颠倒时 inverseOpsBetween 拒绝", () => {
    const { editor, log } = editingSession();
    editor.execute("selection.selectAll");
    editor.execute("format.bold");
    expect(inverseOpsBetween(log(), 1, 1)).toBeNull();
    expect(inverseOpsBetween(log(), 0, 1)).toBeNull();
    expect(inverseOpsBetween(log(), 9, 1)).toBeNull();
  });
});
