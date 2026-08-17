import {
  type BlockAlign,
  isBlockAlign,
  isCodeLanguage,
  isHeadingLevel,
} from "@kaelen/editor-schema";
import type { CommandResult } from "@kaelen/editor-shared-types";
import { selectAll, toggleMark } from "prosemirror-commands";
import { redo, undo } from "prosemirror-history";
import {
  indentListItem,
  insertHardBreak,
  insertHorizontalRule,
  outdentListItem,
  setBlockAlign,
  setCodeBlockLanguage,
  setParagraph,
  toggleBlockquote,
  toggleChecked,
  toggleCodeBlock,
  toggleHeading,
  toggleList,
} from "./block-commands";
import type { EditorSession } from "./session";

/**
 * 命令实现。对上层是不透明的：runtime 只按名字调度，不认识 ProseMirror 类型。
 */
export interface SessionCommand {
  run(session: EditorSession, apply: boolean, input?: unknown): CommandResult;
  /** 需要参数的命令可单独提供无副作用的可用性判断。 */
  enabled?(session: EditorSession, input?: unknown): boolean;
  active(session: EditorSession, input?: unknown): boolean;
  /** 只读态仍可执行（不改文档的命令，例如全选）。默认 false。 */
  readOnly?: boolean;
}

export const coreCommands: Record<string, SessionCommand> = {
  "format.bold": markCommand("strong"),
  "format.italic": markCommand("em"),
  "format.underline": markCommand("underline"),
  "format.strikethrough": markCommand("strikethrough"),
  "format.code": markCommand("code"),

  "block.setParagraph": {
    run: (session, apply) => commandResult(session.applySchemaCommand(setParagraph, apply)),
    active: (session) => session.isBlockActive("paragraph"),
  },
  "block.setHeading": {
    run: (session, apply, input) => {
      const level = headingLevelFrom(input);
      if (level === undefined) {
        return { ok: false, reason: "invalid", detail: "标题层级仅支持 1–4" };
      }
      return commandResult(
        session.applySchemaCommand((schema) => toggleHeading(schema, level), apply),
      );
    },
    active: (session, input) => {
      const level = headingLevelFrom(input);
      return level !== undefined && session.isBlockActive("heading", { level });
    },
  },
  "block.setAlign": {
    run: (session, apply, input) => {
      const align = alignFrom(input);
      if (align === undefined) {
        return {
          ok: false,
          reason: "invalid",
          detail: "对齐仅支持 left/center/right/justify，或 null 恢复默认",
        };
      }
      return commandResult(session.applyCommand(setBlockAlign(align), apply));
    },
    enabled: (session, input) => {
      const align = alignFrom(input);
      return align !== undefined && session.applyCommand(setBlockAlign(align), false);
    },
    active: (session, input) => {
      const align = alignFrom(input);
      return align !== undefined && session.isAligned(align);
    },
  },
  "block.setCodeBlockLanguage": {
    run: (session, apply, input) => {
      const language = languageFrom(input);
      if (language === undefined) {
        return {
          ok: false,
          reason: "invalid",
          detail: "语言名只接受字母开头的标识符（如 typescript、c++），或 null 清除",
        };
      }
      return commandResult(session.applyCommand(setCodeBlockLanguage(language), apply));
    },
    enabled: (session, input) => languageFrom(input) !== undefined && session.hasCodeLanguage(),
    active: (session, input) => {
      const language = languageFrom(input);
      return language !== undefined && session.isCodeLanguage(language);
    },
  },
  "block.toggleBlockquote": {
    run: (session, apply) => commandResult(session.applySchemaCommand(toggleBlockquote, apply)),
    active: (session) => session.isWithin("blockquote"),
  },
  "block.toggleCodeBlock": {
    run: (session, apply) => commandResult(session.applySchemaCommand(toggleCodeBlock, apply)),
    active: (session) => session.isBlockActive("code_block"),
  },
  "block.insertHorizontalRule": {
    run: (session, apply) => commandResult(session.applySchemaCommand(insertHorizontalRule, apply)),
    active: () => false,
  },
  "block.insertHardBreak": {
    run: (session, apply) => commandResult(session.applySchemaCommand(insertHardBreak, apply)),
    active: () => false,
  },

  "list.toggleBullet": listCommand("bullet_list"),
  "list.toggleOrdered": listCommand("ordered_list"),
  "list.toggleTask": listCommand("task_list"),
  "list.indent": {
    run: (session, apply) => commandResult(session.applySchemaCommand(indentListItem, apply)),
    active: () => false,
  },
  "list.outdent": {
    run: (session, apply) => commandResult(session.applySchemaCommand(outdentListItem, apply)),
    active: () => false,
  },
  "list.toggleChecked": {
    run: (session, apply) => commandResult(session.applySchemaCommand(toggleChecked, apply)),
    active: (session) => session.isTaskChecked(),
  },

  "selection.selectAll": {
    run: (session, apply) => commandResult(session.applyCommand(selectAll, apply)),
    active: () => false,
    // 只读态可选中可复制，全选因此仍然可用（方案 §4.1）。
    readOnly: true,
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

function listCommand(listName: string): SessionCommand {
  return {
    run: (session, apply) =>
      commandResult(session.applySchemaCommand((schema) => toggleList(schema, listName), apply)),
    active: (session) => session.isWithin(listName),
  };
}

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

/**
 * 对齐既可以直接传字符串，也可以传 `{ align }`；`null` 是"恢复默认"，
 * 与非法输入（返回 `undefined`）必须分开——前者是一次合法的清除操作。
 */
function alignFrom(input: unknown): BlockAlign | null | undefined {
  if (input === null || isBlockAlign(input)) {
    return input;
  }
  if (typeof input === "object" && "align" in input) {
    const align = (input as { align: unknown }).align;
    return align === null || isBlockAlign(align) ? align : undefined;
  }
  return undefined;
}

/** 语言同样可以直接传字符串或传 `{ language }`；`null` 是"清除语言"。 */
function languageFrom(input: unknown): string | null | undefined {
  if (input === null || isCodeLanguage(input)) {
    return input;
  }
  if (typeof input === "object" && "language" in input) {
    const language = (input as { language: unknown }).language;
    return language === null || isCodeLanguage(language) ? language : undefined;
  }
  return undefined;
}

/** 标题层级既可以直接传数字，也可以传 `{ level }`。 */
function headingLevelFrom(input: unknown): number | undefined {
  if (isHeadingLevel(input)) {
    return input;
  }
  if (typeof input === "object" && input !== null && "level" in input) {
    const level = (input as { level: unknown }).level;
    return isHeadingLevel(level) ? level : undefined;
  }
  return undefined;
}

function commandResult(ok: boolean): CommandResult {
  return ok ? { ok: true } : { ok: false, reason: "disabled" };
}
