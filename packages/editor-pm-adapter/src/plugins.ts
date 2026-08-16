import { UNKNOWN_BLOCK, UNKNOWN_INLINE } from "@kaelen/editor-schema";
import { baseKeymap, chainCommands, newlineInCode, toggleMark } from "prosemirror-commands";
import { history, redo, undo } from "prosemirror-history";
import { inputRules, textblockTypeInputRule, wrappingInputRule } from "prosemirror-inputrules";
import { keymap } from "prosemirror-keymap";
import type { MarkType, NodeType, Schema } from "prosemirror-model";
import { type Command, Plugin, type Transaction } from "prosemirror-state";
import { goToNextCell, tableEditing } from "prosemirror-tables";
import {
  indentListItem,
  insertHardBreak,
  insertHorizontalRule,
  outdentListItem,
  setBlockAlign,
  setParagraph,
  splitListItemCommand,
  toggleBlockquote,
  toggleCodeBlock,
  toggleHeading,
  toggleList,
} from "./block-commands";

/** 快捷键与工具栏走同一批命令实现，两条路径不会各自漂移。 */
function shortcutBindings(schema: Schema): Record<string, Command> {
  const bindings: Record<string, Command> = {
    "Mod-z": undo,
    "Mod-y": redo,
    "Shift-Mod-z": redo,

    "Mod-Alt-0": setParagraph(schema),
    "Mod->": toggleBlockquote(schema),
    "Mod-Alt-c": toggleCodeBlock(schema),
    "Mod-Alt-r": insertHorizontalRule(schema),
    "Mod-Shift-8": toggleList(schema, "bullet_list"),
    "Mod-Shift-9": toggleList(schema, "ordered_list"),
    "Mod-Shift-7": toggleList(schema, "task_list"),

    // 与 Word / Google Docs 同一组键位，肌肉记忆直接迁移过来。
    "Mod-Shift-l": setBlockAlign("left"),
    "Mod-Shift-e": setBlockAlign("center"),
    "Mod-Shift-r": setBlockAlign("right"),
    "Mod-Shift-j": setBlockAlign("justify"),

    // 列表内才生效；不在列表里返回 false，Tab 因此仍然把焦点移出编辑区。
    Tab: indentListItem(schema),
    "Shift-Tab": outdentListItem(schema),
    Enter: splitListItemCommand(schema),
    // 代码块里换行不插 hard_break：那会在 `text*` 内容里塞进一个非法节点。
    "Shift-Enter": chainCommands(newlineInCode, insertHardBreak(schema)),
  };

  for (let level = 1; level <= 4; level += 1) {
    bindings[`Mod-Alt-${level}`] = toggleHeading(schema, level);
  }

  for (const [key, markName] of [
    ["Mod-b", "strong"],
    ["Mod-i", "em"],
    ["Mod-u", "underline"],
    ["Mod-Shift-x", "strikethrough"],
    ["Mod-e", "code"],
  ] as const) {
    const markType = schema.marks[markName];
    if (markType) {
      bindings[key] = toggleMark(markType, undefined, { removeWhenPresent: false });
    }
  }

  return bindings;
}

/**
 * 状态插件。历史被限制在这一处，上层只通过 `history.undo`/`history.redo`
 * 命令访问——M4 换成 Yjs UndoManager 时影响面止于此包（方案 §9.4）。
 */
export function editorPlugins(schema: Schema, isComposing: () => boolean = () => false): Plugin[] {
  return [
    history(),
    compositionInputRules(schema),
    keymap(shortcutBindings(schema)),
    keymap(baseKeymap),
    unknownNodeGuard(schema, isComposing),
    ...tablePlugins(schema),
  ];
}

/** 表格插件安装后才启用其结构修复与导航，未装表格的会话保持零额外行为。 */
function tablePlugins(schema: Schema): Plugin[] {
  const required = ["co_table", "co_table_row", "co_table_cell", "co_table_header"];
  if (!required.every((name) => schema.nodes[name])) {
    return [];
  }
  return [
    tableEditing(),
    keymap({
      Tab: goToNextCell(1),
      "Shift-Tab": goToNextCell(-1),
    }),
  ];
}

/** Markdown 风格输入规则；smart quotes 故意未启用，默认不改写普通标点。 */
function compositionInputRules(schema: Schema): Plugin {
  const heading = schema.nodes.heading;
  const blockquote = schema.nodes.blockquote;
  const bulletList = schema.nodes.bullet_list;
  const orderedList = schema.nodes.ordered_list;
  const codeBlock = schema.nodes.code_block;
  if (!heading || !blockquote || !bulletList || !orderedList || !codeBlock) {
    throw new Error("核心输入规则所需节点缺失");
  }
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,4})\s$/, heading, (match) => ({
        level: match[1]?.length ?? 1,
      })),
      wrappingInputRule(/^>\s$/, blockquote),
      wrappingInputRule(/^[-*]\s$/, bulletList),
      wrappingInputRule(/^(1)\.\s$/, orderedList, (match) => Number.parseInt(match[1] ?? "1", 10)),
      textblockTypeInputRule(/^```\s$/, codeBlock),
    ],
  });
}

/**
 * 程序化事务不进用户历史。历史控制只在这一处知道 ProseMirror 的 meta 键名。
 */
function withoutHistory(transaction: Transaction): Transaction {
  return transaction.setMeta("addToHistory", false);
}

/**
 * 维持"兜底节点不带标记"这一不变量。
 *
 * 不能靠 NodeSpec 的 `marks: ""` 达成：ProseMirror 的 `Transform.addMark` 是按
 * **父节点**的 `allowsMarkType` 判断的，段落允许 strong，行内兜底节点就会被
 * 一并加粗。结果是 DOM 上占位变粗、保存时标记又被丢弃——所见不等于所存。
 * 因此改由 runtime 在事务后清理，并且这个规范化事务不进历史。
 */
function unknownNodeGuard(schema: Schema, isComposing: () => boolean): Plugin {
  const fallbackTypes = new Set<NodeType>(
    [schema.nodes[UNKNOWN_BLOCK], schema.nodes[UNKNOWN_INLINE]].filter(
      (type): type is NodeType => type !== undefined,
    ),
  );

  return new Plugin({
    appendTransaction: (transactions, _oldState, newState) => {
      // appendTransaction 也会改文档；组合态只能让出，不得偷偷规范化。
      if (isComposing()) {
        return null;
      }
      if (!transactions.some((transaction) => transaction.docChanged)) {
        return null;
      }

      const strays: Array<{ from: number; to: number; markType: MarkType }> = [];
      newState.doc.descendants((node, pos) => {
        if (!fallbackTypes.has(node.type)) {
          return true;
        }
        for (const mark of node.marks) {
          strays.push({ from: pos, to: pos + node.nodeSize, markType: mark.type });
        }
        return false;
      });

      if (strays.length === 0) {
        return null;
      }

      const transaction = newState.tr;
      for (const stray of strays) {
        transaction.removeMark(stray.from, stray.to, stray.markType);
      }
      return withoutHistory(transaction);
    },
  });
}
