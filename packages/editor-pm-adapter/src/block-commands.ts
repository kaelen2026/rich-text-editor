import { type BlockAlign, isHeadingLevel } from "@kaelen/editor-schema";
import { lift, setBlockType, wrapIn } from "prosemirror-commands";
import type { NodeType, Node as ProseMirrorNode, ResolvedPos, Schema } from "prosemirror-model";
import { liftListItem, sinkListItem, splitListItem, wrapInList } from "prosemirror-schema-list";
import type { Command, EditorState } from "prosemirror-state";

/** 三种列表及其项类型。项类型不同是待办列表要独立节点名的原因。 */
export const LIST_TYPES: Record<string, string> = {
  bullet_list: "list_item",
  ordered_list: "list_item",
  task_list: "task_item",
};

const LIST_NAMES = new Set(Object.keys(LIST_TYPES));

/** 永远失败的命令：Schema 里没有这个节点时用它，调用方拿到的是"不可用"而不是异常。 */
const unavailable: Command = () => false;

function nodeType(schema: Schema, name: string): NodeType | undefined {
  return schema.nodes[name];
}

/**
 * 能否在当前选区插入某类节点。逐层向外找一个允许它的位置——
 * 只看光标所在层会把"段落里插分隔线"误判为不可用。
 */
function canInsert(state: EditorState, type: NodeType): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    const index = $from.index(depth);
    if ($from.node(depth).canReplaceWith(index, index, type)) {
      return true;
    }
  }
  return false;
}

/**
 * 遍历选区覆盖的每个文本块，并给出该块的解析位置。
 *
 * 一律以"选区里的文本块"为准，而不是 `selection.$from` 的祖先链：全选产生的
 * `AllSelection` 停在文档层（`depth === 0`），用它找祖先会把"整篇都在列表里"
 * 判成"不在列表里"。
 */
function findInSelectedBlocks<TValue>(
  state: EditorState,
  pick: ($block: ResolvedPos, node: ProseMirrorNode) => TValue | null,
): TValue | null {
  let found: TValue | null = null;
  for (const range of state.selection.ranges) {
    if (found !== null) {
      break;
    }
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node, pos) => {
      if (found !== null) {
        return false;
      }
      if (!node.isTextblock) {
        return true;
      }
      found = pick(state.doc.resolve(pos), node);
      return false;
    });
  }
  return found;
}

function eachSelectedBlock(
  state: EditorState,
  visit: ($block: ResolvedPos, node: ProseMirrorNode) => void,
): void {
  findInSelectedBlocks(state, ($block, node) => {
    visit($block, node);
    return null;
  });
}

/** 某个文本块最内层的指定祖先。 */
function ancestorOf(
  $block: ResolvedPos,
  match: (node: ProseMirrorNode) => boolean,
): { node: ProseMirrorNode; pos: number } | null {
  for (let depth = $block.depth; depth > 0; depth -= 1) {
    const node = $block.node(depth);
    if (match(node)) {
      return { node, pos: $block.before(depth) };
    }
  }
  return null;
}

/** 选区里第一个文本块所属的最内层列表。 */
function innermostList(state: EditorState): { node: ProseMirrorNode; pos: number } | null {
  // 第一个文本块就定调：`findInSelectedBlocks` 命中即停，哪怕它不在任何列表里，
  // 也不该拿后面的块来改判——那会把"选区首块在列表外"当成整段都在列表里。
  return (
    findInSelectedBlocks(state, ($block) => ({
      list: ancestorOf($block, (node) => LIST_NAMES.has(node.type.name)),
    }))?.list ?? null
  );
}

export function setParagraph(schema: Schema): Command {
  const paragraph = nodeType(schema, "paragraph");
  return paragraph ? setBlockType(paragraph) : unavailable;
}

/**
 * 段落 ↔ 标题。再点一次同级标题变回段落，工具栏按钮因此是个开关，
 * 与"生效态"语义一致。
 */
export function toggleHeading(schema: Schema, level: number): Command {
  const heading = nodeType(schema, "heading");
  const paragraph = nodeType(schema, "paragraph");
  if (!heading || !paragraph || !isHeadingLevel(level)) {
    return unavailable;
  }
  return (state, dispatch) => {
    const active = isBlockOfType(state, "heading", { level });
    return active
      ? setBlockType(paragraph)(state, dispatch)
      : setBlockType(heading, { level })(state, dispatch);
  };
}

export function toggleBlockquote(schema: Schema): Command {
  const blockquote = nodeType(schema, "blockquote");
  if (!blockquote) {
    return unavailable;
  }
  return (state, dispatch) =>
    isWithinNode(state, "blockquote") ? lift(state, dispatch) : wrapIn(blockquote)(state, dispatch);
}

export function toggleCodeBlock(schema: Schema): Command {
  const codeBlock = nodeType(schema, "code_block");
  const paragraph = nodeType(schema, "paragraph");
  if (!codeBlock || !paragraph) {
    return unavailable;
  }
  return (state, dispatch) =>
    isBlockOfType(state, "code_block")
      ? setBlockType(paragraph)(state, dispatch)
      : setBlockType(codeBlock)(state, dispatch);
}

export function insertHorizontalRule(schema: Schema): Command {
  const rule = nodeType(schema, "horizontal_rule");
  if (!rule) {
    return unavailable;
  }
  return (state, dispatch) => {
    if (!canInsert(state, rule)) {
      return false;
    }
    dispatch?.(state.tr.replaceSelectionWith(rule.create()).scrollIntoView());
    return true;
  };
}

export function insertHardBreak(schema: Schema): Command {
  const hardBreak = nodeType(schema, "hard_break");
  if (!hardBreak) {
    return unavailable;
  }
  return (state, dispatch) => {
    if (!canInsert(state, hardBreak)) {
      return false;
    }
    dispatch?.(state.tr.replaceSelectionWith(hardBreak.create()).scrollIntoView());
    return true;
  };
}

/**
 * 列表开关。已在同类列表里就整体退出，在别类列表里就整段改类型，
 * 都不在就包成列表。
 *
 * 改类型走"整体替换"而不是逐个 `setNodeMarkup`：待办列表的项类型与普通
 * 列表不同，先改外层再改内层会经过一个内容不合法的中间状态。
 */
export function toggleList(schema: Schema, listName: string): Command {
  const listType = nodeType(schema, listName);
  const itemName = LIST_TYPES[listName];
  const itemType = itemName ? nodeType(schema, itemName) : undefined;
  if (!listType || !itemType) {
    return unavailable;
  }
  return (state, dispatch) => {
    const current = innermostList(state);
    if (!current) {
      return wrapInList(listType)(state, dispatch);
    }
    if (current.node.type === listType) {
      return liftListItem(itemType)(state, dispatch);
    }
    if (!dispatch) {
      return true;
    }
    const items: ProseMirrorNode[] = [];
    current.node.forEach((child) => {
      items.push(itemType.create(null, child.content, child.marks));
    });
    const replacement = listType.createChecked(null, items);
    dispatch(
      state.tr
        .replaceWith(current.pos, current.pos + current.node.nodeSize, replacement)
        .scrollIntoView(),
    );
    return true;
  };
}

/**
 * 选区里能对齐的文本块。判据是 Schema 声明了 `align` 属性，而不是一张节点名清单：
 * 代码块刻意没有这个属性（对齐会打乱缩进），插件将来加自己的文本块也不必改这里。
 */
function alignableBlocks(state: EditorState): Array<{ node: ProseMirrorNode; pos: number }> {
  const blocks: Array<{ node: ProseMirrorNode; pos: number }> = [];
  eachSelectedBlock(state, ($block, node) => {
    if (node.type.spec.attrs?.align && !blocks.some((seen) => seen.pos === $block.pos)) {
      blocks.push({ node, pos: $block.pos });
    }
  });
  return blocks;
}

/**
 * 设置选区内文本块的对齐。整段已经是该对齐时再执行一次就清除，
 * 与标题按钮同样的开关语义——工具栏上"生效态"的按钮必须能点回去。
 */
export function setBlockAlign(align: BlockAlign | null): Command {
  return (state, dispatch) => {
    const blocks = alignableBlocks(state);
    if (blocks.length === 0) {
      return false;
    }
    const target =
      align !== null && blocks.every((block) => block.node.attrs.align === align) ? null : align;
    if (blocks.every((block) => block.node.attrs.align === target)) {
      return false;
    }
    if (dispatch) {
      const transaction = state.tr;
      for (const block of blocks) {
        // 位置在整批改属性期间不会移动：setNodeMarkup 不改变任何节点的尺寸。
        transaction.setNodeMarkup(block.pos, undefined, { ...block.node.attrs, align: target });
      }
      dispatch(transaction);
    }
    return true;
  };
}

/** 选区内可对齐的文本块是否**都**是该对齐。空选区（例如只选中图片）不算生效。 */
export function isBlockAligned(state: EditorState, align: BlockAlign | null): boolean {
  const blocks = alignableBlocks(state);
  return blocks.length > 0 && blocks.every((block) => (block.node.attrs.align ?? null) === align);
}

/** 选区覆盖的待办项。跨项选择时一起勾选，与工具栏"作用于选区"的语义一致。 */
function selectedTaskItems(state: EditorState): Array<{ node: ProseMirrorNode; pos: number }> {
  const items: Array<{ node: ProseMirrorNode; pos: number }> = [];
  eachSelectedBlock(state, ($block) => {
    const item = ancestorOf($block, (node) => node.type.name === "task_item");
    if (item && !items.some((seen) => seen.pos === item.pos)) {
      items.push(item);
    }
  });
  return items;
}

/** 勾选/取消选区内的待办项。勾选是内容变更，因此进撤销历史。 */
export function toggleChecked(schema: Schema): Command {
  const taskItem = nodeType(schema, "task_item");
  if (!taskItem) {
    return unavailable;
  }
  return (state, dispatch) => {
    const items = selectedTaskItems(state);
    if (items.length === 0) {
      return false;
    }
    if (dispatch) {
      const checked = !items.every((item) => item.node.attrs.checked === true);
      const transaction = state.tr;
      for (const item of items) {
        transaction.setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked });
      }
      dispatch(transaction);
    }
    return true;
  };
}

/** 对两种列表项各试一次：普通列表与待办列表共用同一组升降级命令。 */
function forEachItemType(schema: Schema, build: (itemType: NodeType) => Command): Command {
  const commands = ["list_item", "task_item"]
    .map((name) => nodeType(schema, name))
    .filter((type): type is NodeType => type !== undefined)
    .map(build);
  return (state, dispatch, view) => commands.some((command) => command(state, dispatch, view));
}

export function indentListItem(schema: Schema): Command {
  return forEachItemType(schema, sinkListItem);
}

export function outdentListItem(schema: Schema): Command {
  return forEachItemType(schema, liftListItem);
}

export function splitListItemCommand(schema: Schema): Command {
  return forEachItemType(schema, splitListItem);
}

/** 选区覆盖的文本块是否都是该类型（并且属性一致）。 */
export function isBlockOfType(
  state: EditorState,
  name: string,
  attrs?: Record<string, unknown>,
): boolean {
  let sawBlock = false;
  let covered = true;
  for (const range of state.selection.ranges) {
    state.doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
      if (!node.isTextblock) {
        return true;
      }
      sawBlock = true;
      if (node.type.name !== name || !attrsMatch(node.attrs, attrs)) {
        covered = false;
      }
      return false;
    });
  }
  return sawBlock && covered;
}

/**
 * 选区覆盖的文本块是否**都**位于某个结构容器（引用、列表）之内。
 * 与 `isBlockOfType` 同样用"整体覆盖"作为生效态语义。
 */
export function isWithinNode(state: EditorState, name: string): boolean {
  let sawBlock = false;
  let covered = true;
  eachSelectedBlock(state, ($block) => {
    sawBlock = true;
    if (!ancestorOf($block, (node) => node.type.name === name)) {
      covered = false;
    }
  });
  return sawBlock && covered;
}

/** 选区内的待办项是否都已勾选。 */
export function isCheckedTaskItem(state: EditorState): boolean {
  const items = selectedTaskItems(state);
  return items.length > 0 && items.every((item) => item.node.attrs.checked === true);
}

function attrsMatch(actual: Record<string, unknown>, expected?: Record<string, unknown>): boolean {
  if (!expected) {
    return true;
  }
  return Object.entries(expected).every(([key, value]) => actual[key] === value);
}
