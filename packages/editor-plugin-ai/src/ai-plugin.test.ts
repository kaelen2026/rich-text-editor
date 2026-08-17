// @vitest-environment jsdom
import { createEditor, type RichEditor } from "@kaelen/editor-api";
import type { SessionBridge, SessionExtension } from "@kaelen/editor-pm-adapter";
import type { EditorPlugin } from "@kaelen/editor-runtime";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aiRequestKey, createAiPlugin } from "./ai-plugin";
import type { AiRequest, AiResult, AiRunOptions, AiService } from "./ai-service";

/**
 * 测试要能精确设定选区、在生成期间插字、并读到 plugin state。这些都走能力插件
 * 用的那条 `SessionBridge`——和 AI 插件自己用的是同一个入口，不是旁路。
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

interface Call {
  request: AiRequest;
  options: AiRunOptions;
  settle: (result: AiResult) => void;
}

/** 记录每一次调用并把结果的兑现权交给用例。 */
function recordingService(): { service: AiService; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    service: {
      run: (request, options) => {
        const gate = deferred<AiResult>();
        calls.push({ request, options, settle: gate.resolve });
        return gate.promise;
      },
    },
  };
}

function documentOf(...paragraphs: string[]) {
  return {
    envelope: 1,
    schemaVersion: 1,
    plugins: {},
    doc: {
      type: "doc",
      content: paragraphs.map((text) => ({
        type: "paragraph",
        attrs: { align: null },
        content: text ? [{ type: "text", text }] : undefined,
      })),
    },
    annotations: [],
  };
}

const editors: RichEditor[] = [];

function setup(...paragraphs: string[]) {
  const probe = createProbe();
  const { service, calls } = recordingService();
  const editor = createEditor({ plugins: [createAiPlugin({ service }), probe.plugin] });
  editors.push(editor);
  editor.loadDocument(documentOf(...paragraphs));
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  return { editor, calls, bridge: probe.bridge, host };
}

/** 文档纯文本，段落之间用 `|` 分隔——摘要用例要看清结果落在哪一段。 */
function text(editor: RichEditor): string {
  return (editor.getDocument().doc.content ?? [])
    .map((block) => (block.content ?? []).map((child) => child.text ?? "").join(""))
    .join("|");
}

function select(bridge: SessionBridge, from: number, to: number): void {
  const state = bridge.getState();
  bridge.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

function insertAt(bridge: SessionBridge, at: number, value: string): void {
  bridge.dispatch(bridge.getState().tr.insertText(value, at));
}

function requests(bridge: SessionBridge) {
  return aiRequestKey.getState(bridge.getState())?.requests ?? [];
}

afterEach(() => {
  while (editors.length > 0) {
    editors.pop()?.destroy();
  }
  document.body.replaceChildren();
});

describe("AI 请求的位置契约", () => {
  it("改写把结果落回选区，原文被替换", async () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);

    expect(editor.execute("ai.rewrite")).toEqual({ ok: true });
    expect(calls[0]?.request).toMatchObject({ action: "rewrite", text: "有座山" });

    calls[0]?.settle({ ok: true, text: "有座庙" });
    await vi.waitFor(() => expect(text(editor)).toBe("从前有座庙"));
  });

  it("生成期间在前面插入大段文字，结果仍落在正确位置", async () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    // 请求已经在飞，此刻发起时算好的 [3,6] 立刻过期。
    insertAt(bridge(), 1, "很久很久以前，");
    expect(requests(bridge())[0]).toMatchObject({ from: 10, to: 13 });

    calls[0]?.settle({ ok: true, text: "有座庙" });
    await vi.waitFor(() => expect(text(editor)).toBe("很久很久以前，从前有座庙"));
  });

  it("紧贴选区外侧输入的文字不会被结果吃掉", async () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    // 贴着选区右边界继续打字：那是用户新写的，不属于要改写的那段。
    insertAt(bridge(), 6, "。真的");
    calls[0]?.settle({ ok: true, text: "有座庙" });

    await vi.waitFor(() => expect(text(editor)).toBe("从前有座庙。真的"));
  });

  it("目标位置在生成期间消失，结果被丢弃且请求被中止", async () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    // 把被改写的那段删掉——结果再回来也没有落点了。
    bridge().dispatch(bridge().getState().tr.delete(3, 6));
    expect(requests(bridge())).toHaveLength(0);
    await vi.waitFor(() => expect(calls[0]?.options.signal.aborted).toBe(true));

    calls[0]?.settle({ ok: true, text: "有座庙" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(text(editor)).toBe("从前");
  });

  it("撤销一步回到改写之前", async () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");
    calls[0]?.settle({ ok: true, text: "有座庙" });
    await vi.waitFor(() => expect(text(editor)).toBe("从前有座庙"));

    // 生成期间文档一字未动，因此回填就是用户看到的那次编辑本身，必须进历史。
    expect(editor.undo()).toEqual({ ok: true });
    expect(text(editor)).toBe("从前有座山");
  });
});

describe("三种意图的落点", () => {
  it("续写插在光标处，不动已有文字", async () => {
    const { editor, calls, bridge } = setup("从前有座山，");
    select(bridge(), 7, 7);

    expect(editor.execute("ai.continue")).toEqual({ ok: true });
    expect(calls[0]?.request).toMatchObject({ action: "continue", text: "从前有座山，" });

    calls[0]?.settle({ ok: true, text: "山里有座庙。" });
    await vi.waitFor(() => expect(text(editor)).toBe("从前有座山，山里有座庙。"));
  });

  it("摘要另起一段落在原文之后，原文一字不动", async () => {
    const { editor, calls, bridge } = setup("很长的一段原文", "后面还有一段");
    select(bridge(), 1, 8);

    expect(editor.execute("ai.summarize")).toEqual({ ok: true });
    expect(calls[0]?.request).toMatchObject({ action: "summarize", text: "很长的一段原文" });

    calls[0]?.settle({ ok: true, text: "一句话摘要" });
    await vi.waitFor(() => expect(text(editor)).toBe("很长的一段原文|一句话摘要|后面还有一段"));
  });

  it("多段结果按空行断成多个段落，不被拍平成一行", async () => {
    const { editor, calls, bridge } = setup("原文");
    select(bridge(), 1, 3);
    editor.execute("ai.rewrite");

    calls[0]?.settle({ ok: true, text: "第一段\n\n第二段" });
    await vi.waitFor(() => expect(text(editor)).toBe("第一段|第二段"));
  });

  it("空选区不能改写或摘要，空文档不能续写", () => {
    const { editor, bridge } = setup("");
    select(bridge(), 1, 1);

    expect(editor.execute("ai.rewrite")).toMatchObject({ ok: false, reason: "disabled" });
    expect(editor.execute("ai.summarize")).toMatchObject({ ok: false, reason: "disabled" });
    expect(editor.execute("ai.continue")).toMatchObject({ ok: false, reason: "disabled" });
    expect(editor.queryCommand("ai.rewrite").enabled).toBe(false);
  });

  it("同一段文字上不允许同时跑两个请求", () => {
    const { editor, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    expect(editor.execute("ai.rewrite")).toMatchObject({ ok: false, reason: "disabled" });
  });
});

describe("流式增量与失败", () => {
  it("增量只进预览，生成期间文档一字不变", async () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    calls[0]?.options.onDelta?.("有座");
    calls[0]?.options.onDelta?.("庙");

    await vi.waitFor(() => expect(requests(bridge())[0]?.preview).toBe("有座庙"));
    expect(text(editor)).toBe("从前有座山");
    expect(editor.getRevision()).toBe(0);
  });

  it("拒答与不可用分开上报，失败后可重试", async () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    calls[0]?.settle({ ok: false, reason: "refused", message: "这段内容不便改写" });
    await vi.waitFor(() =>
      expect(requests(bridge())[0]).toMatchObject({
        status: "failed",
        error: "这段内容不便改写",
      }),
    );
    expect(text(editor)).toBe("从前有座山");

    expect(editor.execute("ai.retry")).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    calls[1]?.settle({ ok: true, text: "有座庙" });
    await vi.waitFor(() => expect(text(editor)).toBe("从前有座庙"));
  });

  it("服务抛错按不可用处理，文档不受影响", async () => {
    const probe = createProbe();
    const editor = createEditor({
      plugins: [
        createAiPlugin({ service: { run: () => Promise.reject(new Error("网络不可达")) } }),
        probe.plugin,
      ],
    });
    editors.push(editor);
    editor.loadDocument(documentOf("从前有座山"));
    const host = document.createElement("div");
    document.body.append(host);
    editor.mount(host);
    select(probe.bridge(), 3, 6);

    editor.execute("ai.rewrite");

    await vi.waitFor(() =>
      expect(requests(probe.bridge())[0]).toMatchObject({
        status: "failed",
        error: "网络不可达",
      }),
    );
    expect(text(editor)).toBe("从前有座山");
  });

  it("取消中止请求并收掉记录", async () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    expect(editor.execute("ai.cancel")).toEqual({ ok: true });
    expect(requests(bridge())).toHaveLength(0);
    expect(calls[0]?.options.signal.aborted).toBe(true);

    // 取消之后结果再回来也不能改文档。
    calls[0]?.settle({ ok: true, text: "有座庙" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(text(editor)).toBe("从前有座山");
  });

  it("卸载编辑器中止仍在飞行的请求", () => {
    const { editor, calls, bridge } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    editor.unmount();

    expect(calls[0]?.options.signal.aborted).toBe(true);
  });
});

describe("组合态（方案 §9.6）", () => {
  function compose(host: HTMLElement, type: "compositionstart" | "compositionend"): void {
    host
      .querySelector(".ProseMirror")
      ?.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
  }

  it("组合期间不受理新的 AI 请求", () => {
    const { editor, calls, bridge, host } = setup("从前有座山");
    select(bridge(), 3, 6);
    compose(host, "compositionstart");

    expect(editor.execute("ai.rewrite")).toEqual({ ok: false, reason: "composing" });
    expect(calls).toHaveLength(0);
  });

  it("组合期间到达的结果被挂起，组合结束后按映射后的位置落地", async () => {
    const { editor, calls, bridge, host } = setup("从前有座山");
    select(bridge(), 3, 6);
    editor.execute("ai.rewrite");

    compose(host, "compositionstart");
    calls[0]?.settle({ ok: true, text: "有座庙" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 回填是典型的程序化事务：组合期间必须让位给输入法。
    expect(text(editor)).toBe("从前有座山");

    compose(host, "compositionend");
    await vi.waitFor(() => expect(text(editor)).toBe("从前有座庙"), { timeout: 2000 });
  });
});
