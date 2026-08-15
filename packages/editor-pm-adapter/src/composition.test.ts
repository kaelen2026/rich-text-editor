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

describe("输入法组合态", () => {
  it("组合态挂起非用户文档事务，并在结束后映射冲刷", () => {
    const { host, session } = mountedSession();
    compose(host, "compositionstart");

    insert(session, "程序化");
    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("初始");

    session.applyCommand((state, dispatch) => {
      dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 1)));
      return true;
    }, true);
    compose(host, "compositionend");

    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("程序化初始");
    expect(session.composing).toBe(false);
  });

  it("按排队顺序冲刷多笔非用户事务", () => {
    const { host, session } = mountedSession();
    compose(host, "compositionstart");

    insert(session, "甲");
    insert(session, "乙");
    compose(host, "compositionend");

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
    expect(session.docJSON.content?.[0]?.content?.[0]?.text).toBe("兜底初始");
    expect(session.composing).toBe(false);
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
