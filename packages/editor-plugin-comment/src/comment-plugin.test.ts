// @vitest-environment jsdom
import { createEditor, type RichEditor } from "@kaelen/editor-api";
import type { SessionBridge, SessionExtension } from "@kaelen/editor-pm-adapter";
import type { EditorPlugin } from "@kaelen/editor-runtime";
import type { Annotation, EditorEnvelope } from "@kaelen/editor-shared-types";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, it } from "vitest";
import { createCommentPlugin } from "./comment-plugin";

/**
 * 与 AI 插件的测试同一条思路：探针走能力插件用的那条 `SessionBridge`，
 * 用它精确设定选区、派发编辑事务——不是旁路，正是异步回填走的那条入口。
 */
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

interface Editor {
  editor: RichEditor;
  bridge: () => SessionBridge;
  host: HTMLElement;
}

const editors: Editor[] = [];

function boot(envelope = documentOf("0123456789")): Editor {
  const probe = createProbe();
  const editor = createEditor({ plugins: [createCommentPlugin(), probe.plugin] });
  expect(editor.loadDocument(envelope).ok).toBe(true);
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  const handle = { editor, bridge: probe.bridge, host };
  editors.push(handle);
  return handle;
}

afterEach(() => {
  while (editors.length > 0) {
    const handle = editors.pop();
    handle?.editor.destroy();
    handle?.host.remove();
  }
});

function select(bridge: SessionBridge, from: number, to: number): void {
  const state = bridge.getState();
  bridge.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

function insertText(bridge: SessionBridge, at: number, text: string): void {
  bridge.dispatch(bridge.getState().tr.insertText(text, at));
}

function deleteRange(bridge: SessionBridge, from: number, to: number): void {
  bridge.dispatch(bridge.getState().tr.delete(from, to));
}

function textAt(bridge: SessionBridge, annotation: Annotation): string {
  return bridge.getState().doc.textBetween(annotation.from, annotation.to, "\n");
}

describe("单机评论：命令与锚点", () => {
  it("comment.add 把选区锚成一条批注，评论出现在 getAnnotations()", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    const result = editor.execute("comment.add", { id: "c1", payload: { text: "看看这段" } });
    expect(result.ok).toBe(true);
    expect(editor.getAnnotations()).toEqual([
      { id: "c1", from: 3, to: 7, orphaned: false, payload: { text: "看看这段" } },
    ]);
  });

  it("空选区不能加评论：enabled 为 false，执行返回 invalid", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 3);
    expect(editor.queryCommand("comment.add").enabled).toBe(false);
    expect(editor.execute("comment.add", { payload: "x" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("重复的 id 被拒绝，原批注不受影响", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    expect(editor.execute("comment.add", { id: "c1", payload: "第一条" }).ok).toBe(true);
    select(bridge(), 1, 2);
    expect(editor.execute("comment.add", { id: "c1", payload: "重复" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(editor.getAnnotations()).toHaveLength(1);
    expect(editor.getAnnotations()[0]?.payload).toBe("第一条");
  });

  it("comment.remove 删除批注；不存在的 id 返回 invalid", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    expect(editor.execute("comment.remove", { id: "c1" }).ok).toBe(true);
    expect(editor.getAnnotations()).toEqual([]);
    expect(editor.execute("comment.remove", { id: "c1" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("选区落在批注上时 comment.add 的 active 为 true，供工具栏点亮", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    select(bridge(), 4, 5);
    expect(editor.queryCommand("comment.add").active).toBe(true);
    select(bridge(), 8, 9);
    expect(editor.queryCommand("comment.add").active).toBe(false);
  });

  it("payload 与调用方隔离：外部改自己的对象不影响已存的批注", () => {
    const { editor, bridge } = boot();
    const payload = { text: "原文" };
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload });
    payload.text = "被外部改掉了";
    expect(editor.getAnnotations()[0]?.payload).toEqual({ text: "原文" });
  });
});

describe("单机评论：锚点随事务映射（§9.5 同一套机制）", () => {
  it("在批注前插入文字，锚点整体右移，指向的仍是同一段文字", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    insertText(bridge(), 1, "插在前面的");
    const annotation = editor.getAnnotations()[0];
    expect(annotation).toMatchObject({ from: 8, to: 12, orphaned: false });
    expect(textAt(bridge(), annotation as Annotation)).toBe("2345");
  });

  it("紧贴批注两端外侧输入的文字留在批注之外", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    // 贴着起点打字：新字不进批注。
    insertText(bridge(), 3, "AB");
    // 贴着终点打字：新字也不进批注。
    let annotation = editor.getAnnotations()[0] as Annotation;
    insertText(bridge(), annotation.to, "CD");
    annotation = editor.getAnnotations()[0] as Annotation;
    expect(textAt(bridge(), annotation)).toBe("2345");
  });

  it("在批注中间插入文字，批注扩展并包住新文字", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    insertText(bridge(), 5, "中间");
    const annotation = editor.getAnnotations()[0] as Annotation;
    expect(textAt(bridge(), annotation)).toBe("23中间45");
  });

  it("批注被部分删除时区间收缩，剩余文字仍被锚住", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    deleteRange(bridge(), 5, 7);
    const annotation = editor.getAnnotations()[0] as Annotation;
    expect(annotation.orphaned).toBe(false);
    expect(textAt(bridge(), annotation)).toBe("23");
  });

  it("锚定文字被整段删除时置 orphaned，批注本体不消失（§9.8）", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: { text: "别丢" } });
    deleteRange(bridge(), 2, 8);
    expect(editor.getAnnotations()).toEqual([
      { id: "c1", from: 2, to: 2, orphaned: true, payload: { text: "别丢" } },
    ]);
  });

  it("orphaned 在单机下不可逆：后续编辑不会让它复活", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    deleteRange(bridge(), 2, 8);
    insertText(bridge(), 2, "新的文字");
    expect(editor.getAnnotations()[0]?.orphaned).toBe(true);
  });

  it("选区两端贴在块边界上时收进紧邻文字：不吞没被选中的块", () => {
    const { editor, bridge } = boot(documentOf("甲乙丙", "丁戊己"));
    // 文档：p1 = 1..4（甲乙丙），p2 = 6..9（丁戊己）。
    // 终点贴 p2 开头（p2 一个字没选）→ 收回 p1 末尾。
    select(bridge(), 2, 6);
    editor.execute("comment.add", { id: "c1", payload: null });
    expect(textAt(bridge(), editor.getAnnotations()[0] as Annotation)).toBe("乙丙");
    // 起点贴 p1 末尾（p1 一个字没选）→ 前进到 p2 开头。
    select(bridge(), 4, 8);
    editor.execute("comment.add", { id: "c2", payload: null });
    expect(textAt(bridge(), editor.getAnnotations()[1] as Annotation)).toBe("丁戊");
  });

  it("属性：随机编辑序列后锚点仍指向同一段文字", () => {
    // 线性同余伪随机数：种子固定，失败可复现。
    let seed = 20260817;
    const random = (bound: number): number => {
      seed = (seed * 48271) % 2147483647;
      return seed % bound;
    };
    const marker = "MMMMM";
    const { editor, bridge } = boot(documentOf(`aaaa${marker}bbbb`));
    select(bridge(), 5, 5 + marker.length);
    editor.execute("comment.add", { id: "c1", payload: "x" });

    for (let round = 0; round < 200; round += 1) {
      const annotation = editor.getAnnotations()[0] as Annotation;
      const state = bridge().getState();
      const size = state.doc.content.size;
      if (random(2) === 0) {
        // 插入：任何不严格位于批注内部的位置（两端边界也允许，验证偏向）。
        const spots = [1, annotation.from, annotation.to, Math.min(annotation.to + 1, size - 1)];
        insertText(bridge(), spots[random(spots.length)] as number, "xy");
      } else {
        // 删除：只删批注之外的内容。
        if (annotation.from > 2) {
          const from = 1 + random(annotation.from - 2);
          deleteRange(bridge(), from, from + 1);
        }
      }
      expect(textAt(bridge(), editor.getAnnotations()[0] as Annotation)).toBe(marker);
    }
  });
});

describe("评论是元数据不是正文", () => {
  it("评论不进 getHTML() 与 getMarkdown()", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: { text: "泄漏检查" } });
    expect(editor.getHTML()).not.toContain("comment");
    expect(editor.getHTML()).not.toContain("泄漏检查");
    expect(editor.getMarkdown()).not.toContain("泄漏检查");
  });

  it("评论高亮以 Decoration 呈现在 DOM 上，orphaned 的没有高亮", () => {
    const { editor, bridge, host } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    const highlight = host.querySelector(".co-comment");
    expect(highlight?.textContent).toBe("2345");
    expect(highlight?.getAttribute("data-comment-id")).toBe("c1");
    deleteRange(bridge(), 2, 8);
    expect(host.querySelector(".co-comment")).toBeNull();
  });
});

describe("信封 round-trip（§9.8：批注存信封的 annotations）", () => {
  it("getDocument() 带出当前批注；装载含批注的信封后批注可见且继续映射", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: { text: "留住" } });
    const saved = JSON.parse(JSON.stringify(editor.getDocument())) as EditorEnvelope;
    expect(saved.annotations).toEqual([
      { id: "c1", from: 3, to: 7, orphaned: false, payload: { text: "留住" } },
    ]);

    const second = boot(saved);
    expect(second.editor.getAnnotations()).toEqual(saved.annotations);
    insertText(second.bridge(), 1, "又插了几个字");
    const annotation = second.editor.getAnnotations()[0] as Annotation;
    expect(textAt(second.bridge(), annotation)).toBe("2345");
  });

  it("装载新文档丢弃上一份文档的批注", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    expect(editor.loadDocument(documentOf("另一篇")).ok).toBe(true);
    expect(editor.getAnnotations()).toEqual([]);
    expect(editor.getDocument().annotations).toEqual([]);
  });

  it("未装评论插件时 getAnnotations() 原样透出信封里的批注", () => {
    const editor = createEditor();
    const envelope = documentOf("hello");
    envelope.annotations = [{ id: "c1", from: 1, to: 3, orphaned: false, payload: null }];
    expect(editor.loadDocument(envelope).ok).toBe(true);
    expect(editor.getAnnotations()).toEqual(envelope.annotations);
    expect(editor.getDocument().annotations).toEqual(envelope.annotations);
    editor.destroy();
  });

  it("getAnnotations() 引用稳定：没有批注变化时返回同一个数组", () => {
    const { editor, bridge } = boot();
    select(bridge(), 3, 7);
    editor.execute("comment.add", { id: "c1", payload: "x" });
    const first = editor.getAnnotations();
    // 仅选区变化，不动批注。
    select(bridge(), 1, 2);
    expect(editor.getAnnotations()).toBe(first);
  });
});
