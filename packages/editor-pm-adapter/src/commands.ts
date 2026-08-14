import { selectAll, toggleMark } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import type { EditorSession } from "./session";

/**
 * 命令实现。对上层是不透明的：runtime 只按名字调度，不认识 ProseMirror 类型。
 */
export interface SessionCommand {
  run(session: EditorSession, apply: boolean): boolean;
  active(session: EditorSession): boolean;
}

export const coreCommands: Record<string, SessionCommand> = {
  "format.bold": markCommand("strong"),
  "format.italic": markCommand("em"),
  "selection.selectAll": {
    run: (session, apply) => session.applyCommand(selectAll, apply),
    active: () => false,
  },
  "history.undo": {
    run: (session, apply) => session.applyCommand(undo, apply),
    active: () => false,
  },
  "history.redo": {
    run: (session, apply) => session.applyCommand(redo, apply),
    active: () => false,
  },
};

function markCommand(markName: string): SessionCommand {
  return {
    run: (session, apply) =>
      session.applyCommand((state, dispatch) => {
        const markType = session.markType(markName);
        if (!markType) {
          return false;
        }
        // removeWhenPresent:false —— 部分命中时补齐而不是取消，与生效态语义一致。
        return toggleMark(markType, undefined, { removeWhenPresent: false })(state, dispatch);
      }, apply),
    active: (session) => session.isMarkActive(markName),
  };
}
