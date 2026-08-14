import type { CommandResult } from "@kaelen/editor-shared-types";
import { selectAll, toggleMark } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import type { EditorSession } from "./session";

/**
 * 命令实现。对上层是不透明的：runtime 只按名字调度，不认识 ProseMirror 类型。
 */
export interface SessionCommand {
  run(session: EditorSession, apply: boolean, input?: unknown): CommandResult;
  /** 需要参数的命令可单独提供无副作用的可用性判断。 */
  enabled?(session: EditorSession): boolean;
  active(session: EditorSession): boolean;
}

export const coreCommands: Record<string, SessionCommand> = {
  "format.bold": markCommand("strong"),
  "format.italic": markCommand("em"),
  "selection.selectAll": {
    run: (session, apply) => commandResult(session.applyCommand(selectAll, apply)),
    active: () => false,
  },
  "history.undo": {
    run: (session, apply) => commandResult(session.applyCommand(undo, apply)),
    active: () => false,
  },
  "history.redo": {
    run: (session, apply) => commandResult(session.applyCommand(redo, apply)),
    active: () => false,
  },
};

function markCommand(markName: string): SessionCommand {
  return {
    run: (session, apply) =>
      commandResult(
        session.applyCommand((state, dispatch) => {
          const markType = session.markType(markName);
          if (!markType) {
            return false;
          }
          // removeWhenPresent:false —— 部分命中时补齐而不是取消，与生效态语义一致。
          return toggleMark(markType, undefined, { removeWhenPresent: false })(state, dispatch);
        }, apply),
      ),
    active: (session) => session.isMarkActive(markName),
  };
}

function commandResult(ok: boolean): CommandResult {
  return ok ? { ok: true } : { ok: false, reason: "disabled" };
}
