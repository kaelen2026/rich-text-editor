import { baseKeymap, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { Schema } from "prosemirror-model";
import type { Command, Plugin } from "prosemirror-state";

/**
 * 状态插件。历史被限制在这一处，上层只通过 `history.undo`/`history.redo`
 * 命令访问——M4 换成 Yjs UndoManager 时影响面止于此包（方案 §9.4）。
 */
export function editorPlugins(schema: Schema): Plugin[] {
  const bindings: Record<string, Command> = {
    "Mod-z": undo,
    "Mod-y": redo,
    "Shift-Mod-z": redo,
  };

  const strong = schema.marks.strong;
  if (strong) {
    bindings["Mod-b"] = toggleMark(strong, undefined, { removeWhenPresent: false });
  }
  const em = schema.marks.em;
  if (em) {
    bindings["Mod-i"] = toggleMark(em, undefined, { removeWhenPresent: false });
  }

  return [history(), keymap(bindings), keymap(baseKeymap)];
}
