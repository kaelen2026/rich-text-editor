import { createEditor, type RichEditor } from "@kaelen/editor-api";
import { createCommentPlugin } from "@kaelen/editor-plugin-comment";
import {
  appendVersionLogEntry,
  buildSchema,
  createVersionLog,
  documentAtRevision,
  type SessionBridge,
  type SessionExtension,
  versionLogTip,
} from "@kaelen/editor-pm-adapter";
import type { EditorPlugin } from "@kaelen/editor-runtime";
import type {
  DocumentPatch,
  EditorEnvelope,
  NodeJSON,
  VersionLog,
} from "@kaelen/editor-shared-types";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, it } from "vitest";
import { createVersionHistoryPlugin } from "./version-history-plugin";

function createProbe(): { plugin: EditorPlugin; bridge: () => SessionBridge } {
  let bridge: SessionBridge | undefined;
  const extension: SessionExtension = {
    plugins: () => [],
    bind: (session) => {
      bridge = session;
    },
    destroy: () => {
      bridge = undefined;
    },
  };
  return {
    plugin: {
      name: "probe",
      version: "0.0.1",
      namespace: "co_",
      createSessionExtensions: () => [extension],
    },
    bridge: () => {
      if (!bridge) {
        throw new Error("探针尚未绑定");
      }
      return bridge;
    },
  };
}

function documentOf(...paragraphs: string[]): EditorEnvelope {
  return {
    envelope: 1,
    schemaVersion: 1,
    plugins: {},
    doc: {
      type: "doc",
      content: paragraphs.map((text) => ({
        type: "paragraph",
        content: text.length > 0 ? [{ type: "text", text }] : [],
      })),
    },
    annotations: [],
  };
}

interface Session {
  editor: RichEditor;
  bridge: () => SessionBridge;
  log: () => VersionLog;
}

const editors: RichEditor[] = [];

/** 装载基线文档并把 patch 流累积成版本日志——宿主该做的事，测试里如实做。 */
function boot(envelope = documentOf("0123456789")): Session {
  const probe = createProbe();
  const editor = createEditor({
    plugins: [createVersionHistoryPlugin(), createCommentPlugin(), probe.plugin],
  });
  expect(editor.loadDocument(envelope).ok).toBe(true);
  let log = createVersionLog(JSON.parse(JSON.stringify(envelope.doc)) as NodeJSON, 0);
  editor.subscribe("patch", (patch: DocumentPatch) => {
    const appended = appendVersionLogEntry(log, patch);
    if (appended.ok) {
      log = appended.log;
    }
  });
  editors.push(editor);
  return { editor, bridge: probe.bridge, log: () => log };
}

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
});

function insertText(session: Session, at: number, text: string): void {
  const bridge = session.bridge();
  bridge.dispatch(bridge.getState().tr.insertText(text, at));
}

function docJSON(session: Session): NodeJSON {
  return JSON.parse(JSON.stringify(session.editor.getDocument().doc)) as NodeJSON;
}

describe("version.restore：恢复是追加一笔反向变更", () => {
  it("恢复到较早版本后文档与目标版本全等，恢复自身也进版本日志", () => {
    const session = boot();
    insertText(session, 1, "第一笔");
    insertText(session, 1, "第二笔");
    insertText(session, 1, "第三笔");
    expect(versionLogTip(session.log())).toBe(3);

    const result = session.editor.execute("version.restore", {
      history: session.log(),
      revision: 1,
    });
    expect(result.ok).toBe(true);

    const target = documentAtRevision(buildSchema(), session.log(), 1);
    expect(target.ok).toBe(true);
    if (target.ok) {
      expect(docJSON(session)).toEqual(target.document);
    }
    // 恢复不是回退指针：日志长了一格，恢复那一笔自己也在历史里。
    expect(versionLogTip(session.log())).toBe(4);
  });

  it("恢复可以被撤销：撤销一步回到恢复之前的内容", () => {
    const session = boot();
    insertText(session, 1, "甲");
    insertText(session, 1, "乙");
    const before = docJSON(session);

    expect(
      session.editor.execute("version.restore", { history: session.log(), revision: 1 }).ok,
    ).toBe(true);
    expect(docJSON(session)).not.toEqual(before);

    expect(session.editor.undo().ok).toBe(true);
    expect(docJSON(session)).toEqual(before);
  });

  it("恢复只动该动的区间：压在别处的批注原样存活（§9.8 协同效应）", () => {
    const session = boot(documentOf("甲乙丙", "丁戊己"));
    // 批注锚在第一段。
    const bridge = session.bridge();
    bridge.dispatch(
      bridge.getState().tr.setSelection(TextSelection.create(bridge.getState().doc, 2, 4)),
    );
    expect(session.editor.execute("comment.add", { id: "c1", payload: null }).ok).toBe(true);
    const anchored = session.editor.getAnnotations()[0];

    // 编辑只发生在第二段（位置 6 之后）。
    insertText(session, 7, "改一");
    insertText(session, 7, "改二");

    expect(
      session.editor.execute("version.restore", { history: session.log(), revision: 0 }).ok,
    ).toBe(true);
    // 第二段回到基线，第一段的批注一步没挪、也没变孤儿。
    expect(session.editor.getAnnotations()[0]).toEqual(anchored);
    const state = session.bridge().getState();
    expect(state.doc.textBetween(0, state.doc.content.size, "\n")).toBe("甲乙丙\n丁戊己");
  });

  it("恢复到当前版本或范围之外是 invalid，不产生事务", () => {
    const session = boot();
    insertText(session, 1, "甲");
    const before = docJSON(session);
    const tip = versionLogTip(session.log());

    for (const revision of [tip, tip + 5, -1]) {
      expect(
        session.editor.execute("version.restore", { history: session.log(), revision }),
      ).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(docJSON(session)).toEqual(before);
    expect(versionLogTip(session.log())).toBe(tip);
  });

  it("历史与当前文档对不上时拒绝恢复，文档一字不动", () => {
    const session = boot();
    insertText(session, 1, "真实内容");

    // 另一个编辑器产生的、修订号看起来合法的日志——但内容不是这份文档的历史。
    const foreign = boot(documentOf("完全无关"));
    insertText(foreign, 1, "别的编辑");
    const before = docJSON(session);

    expect(
      session.editor.execute("version.restore", { history: foreign.log(), revision: 0 }),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(docJSON(session)).toEqual(before);
  });

  it("输入不成形（缺 history、缺 revision）时 enabled 为 false", () => {
    const session = boot();
    insertText(session, 1, "甲");
    expect(session.editor.queryCommand("version.restore").enabled).toBe(false);
    expect(session.editor.queryCommand("version.restore", { revision: 0 }).enabled).toBe(false);
    expect(
      session.editor.queryCommand("version.restore", { history: session.log(), revision: 0 })
        .enabled,
    ).toBe(true);
  });
});
