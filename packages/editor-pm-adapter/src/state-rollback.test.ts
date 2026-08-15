import type { NodeJSON } from "@kaelen/editor-shared-types";
import { TextSelection } from "prosemirror-state";
import { describe, expect, it, vi } from "vitest";
import { buildSchema } from "./schema";
import { EditorSession } from "./session";

const doc: NodeJSON = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "一二三四五" }] }],
};

function createSession(onChange = vi.fn()) {
  const session = new EditorSession(buildSchema(), doc, onChange);
  session.applyCommand((state, dispatch) => {
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 2, 5)));
    return true;
  }, true);
  onChange.mockClear();
  return session;
}

describe("受保护的状态检查点", () => {
  it("回调抛错时文档与选区回到调用前", () => {
    const session = createSession();

    const outcome = session.runProtected(() => {
      session.applyCommand((state, dispatch) => {
        dispatch?.(state.tr.insertText("插入", 1));
        return true;
      }, true);
      throw new Error("改完文档才炸");
    });

    expect(outcome.ok).toBe(false);
    expect(session.docJSON).toEqual(doc);
    expect(session.selection).toEqual({ anchor: 2, head: 5 });
  });

  it("回调正常返回时状态照常推进", () => {
    const session = createSession();

    const outcome = session.runProtected(() =>
      session.applyCommand((state, dispatch) => {
        dispatch?.(state.tr.insertText("插入", 1));
        return true;
      }, true),
    );

    expect(outcome).toEqual({ ok: true, value: true });
    expect(session.docJSON).not.toEqual(doc);
  });

  it("回滚改动了文档时通知一次变更，未改动则不通知", () => {
    const onChange = vi.fn();
    const session = createSession(onChange);

    session.runProtected(() => {
      throw new Error("没碰文档就炸了");
    });
    expect(onChange).not.toHaveBeenCalled();

    session.runProtected(() => {
      session.applyCommand((state, dispatch) => {
        dispatch?.(state.tr.insertText("插入", 1));
        return true;
      }, true);
      throw new Error("改完再炸");
    });
    // 一次来自插件的事务，一次来自回滚。
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(true);
  });
});
