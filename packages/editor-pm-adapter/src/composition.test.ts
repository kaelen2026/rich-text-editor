// @vitest-environment jsdom
import type { NodeJSON } from "@kaelen/editor-shared-types";
import { EditorState, TextSelection, type Transaction } from "prosemirror-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editorPlugins } from "./plugins";
import { buildSchema } from "./schema";
import { EditorSession } from "./session";

const doc: NodeJSON = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "初始" }] }],
};

function mountedSession(onCompositionChange = vi.fn()): {
  host: HTMLElement;
  session: EditorSession;
} {
  const host = document.createElement("div");
  document.body.append(host);
  const session = new EditorSession(buildSchema(), doc, () => {}, "edit", onCompositionChange);
  session.mount(host);
  return { host, session };
}

function compose(host: HTMLElement, type: "compositionstart" | "compositionend"): void {
  host
    .querySelector<HTMLElement>("[contenteditable=true]")
    ?.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
}

function insert(session: EditorSession, text: string): void {
  session.applyCommand((state, dispatch) => {
    dispatch?.(state.tr.insertText(text, state.selection.from));
    return true;
  }, true);
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

/**
 * `compositionend` 之后队列不再同步冲刷：要等下一笔事务（真实浏览器里就是上屏
 * 文本那一笔），一直没有则由 250ms 兜底。理由见 `session.ts` 的 `scheduleFlush`。
 * jsdom 里造不出上屏那一笔，因此这些用例走兜底路径。
 */
function endComposition(host: HTMLElement): void {
  compose(host, "compositionend");
  vi.advanceTimersByTime(250);
}

describe("输入法组合态", () => {
  it("组合态挂起非用户文档事务，并在结束后映射冲刷", () => {
    vi.useFakeTimers();
    const { host, session } = mountedSession();
    compose(host, "compositionstart");

    insert(session, "程序化");
    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("初始");

    session.applyCommand((state, dispatch) => {
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 1)));
      return true;
    }, true);
    endComposition(host);

    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("程序化初始");
    expect(session.composing).toBe(false);
  });

  it("组合结束后先到的那笔事务负责冲刷，不必等兜底超时", async () => {
    vi.useFakeTimers();
    const { host, session } = mountedSession();
    compose(host, "compositionstart");
    insert(session, "回填");

    compose(host, "compositionend");
    // 组合态标志立刻恢复，但队列还没落地——此刻模型可能还没追上 DOM。
    expect(session.composing).toBe(false);
    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("初始");

    // 下一笔事务代表"模型已经追上"，冲刷随它一起发生，一个定时器都不用等；
    // 但要等它自己走完（微任务），不能在它的调用栈里插队。
    insert(session, "上屏");
    await Promise.resolve();
    // "回填"排队时记的位置是 1，被"上屏"往后推了两格——落在它后面才是映射对了。
    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("上屏回填初始");
  });

  it("按排队顺序冲刷多笔非用户事务", () => {
    vi.useFakeTimers();
    const { host, session } = mountedSession();
    compose(host, "compositionstart");

    insert(session, "甲");
    insert(session, "乙");
    endComposition(host);

    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("甲乙初始");
  });

  it("遗漏 compositionend 时在五秒后退出并冲刷队列", () => {
    vi.useFakeTimers();
    const { host, session } = mountedSession();
    compose(host, "compositionstart");
    insert(session, "兜底");

    vi.advanceTimersByTime(4_999);
    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("初始");
    expect(session.composing).toBe(true);

    vi.advanceTimersByTime(1);
    expect(session.composing).toBe(false);
    // 五秒兜底退出组合态后，冲刷仍走 `scheduleFlush` 的那条延迟路径。
    vi.advanceTimersByTime(250);
    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("兜底初始");
  });
});

describe("Markdown 输入规则", () => {
  it.each([
    ["#", "heading"],
    [">", "blockquote"],
    ["-", "bullet_list"],
    ["1.", "ordered_list"],
    ["```", "code_block"],
  ])("输入 %s 加空格时转换为 %s", (prefix, expectedType) => {
    const schema = buildSchema();
    const plugin = editorPlugins(schema).find((candidate) => candidate.spec.isInputRules === true);
    if (!plugin) {
      throw new Error("输入规则插件缺失");
    }
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", undefined, [
        schema.node("paragraph", undefined, schema.text(prefix)),
      ]),
      plugins: [plugin],
    });
    const view = {
      get state() {
        return state;
      },
      composing: false,
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
      },
    };

    const handled = plugin.props.handleTextInput?.call(
      plugin,
      view as never,
      prefix.length + 1,
      prefix.length + 1,
      " ",
      () => state.tr,
    );

    expect(handled).toBe(true);
    expect(state.doc.firstChild?.type.name).toBe(expectedType);
  });

  it("组合态不执行输入规则", () => {
    const schema = buildSchema();
    const plugin = editorPlugins(schema).find((candidate) => candidate.spec.isInputRules === true);
    if (!plugin) {
      throw new Error("输入规则插件缺失");
    }
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", undefined, [schema.node("paragraph", undefined, schema.text("#"))]),
      plugins: [plugin],
    });
    const view = {
      get state() {
        return state;
      },
      composing: true,
      dispatch(transaction: Transaction) {
        state = state.apply(transaction);
      },
    };

    const handled = plugin.props.handleTextInput?.call(
      plugin,
      view as never,
      2,
      2,
      " ",
      () => state.tr,
    );

    expect(handled).toBe(false);
    expect(state.doc.firstChild?.type.name).toBe("paragraph");
  });
});
