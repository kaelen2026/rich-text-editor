import type {
  CoreMarkSpec,
  CoreNodeSpec,
  CoreNodeView,
  DomOutputSpec,
} from "@kaelen/editor-shared-types";

/** 兜底节点名。属于冻结核心集，永不改名。 */
export const UNKNOWN_BLOCK = "unknown_block";
export const UNKNOWN_INLINE = "unknown_inline";

function unknownPlaceholder(tag: string, node: CoreNodeView): DomOutputSpec {
  const nodeName = String(node.attrs.nodeName ?? "未知内容");
  return [
    tag,
    {
      "data-unknown-node": nodeName,
      class: "co-unknown",
      contenteditable: "false",
    },
    `此内容需要「${nodeName}」功能才能显示与编辑`,
  ];
}

/** 标题层级为产品决策：h1–h4，扩展是纯增量变更（方案 §4.1）。 */
export const MAX_HEADING_LEVEL = 4;
export type HeadingLevel = 1 | 2 | 3 | 4;

export function isHeadingLevel(value: unknown): value is HeadingLevel {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_HEADING_LEVEL
  );
}

/** 渲染前把层级钳进合法区间：文档可能来自手写 JSON 或旧版本，`h7` 不是标签。 */
function headingTag(level: unknown): string {
  return `h${isHeadingLevel(level) ? level : 1}`;
}

/**
 * 冻结核心节点集：不带命名空间前缀，永不改名（方案 §9.2）。
 * paragraph 必须排在其余块节点之前——ProseMirror 用声明顺序决定
 * `block+` 位置的默认节点类型，换个顺序默认块就不是段落了。
 */
export const coreNodes: Record<string, CoreNodeSpec> = {
  doc: { content: "block+" },
  paragraph: {
    content: "inline*",
    group: "block",
    parseDOM: [{ tag: "p" }],
    toDOM: () => ["p", 0],
  },
  text: { group: "inline" },

  heading: {
    content: "inline*",
    group: "block",
    defining: true,
    attrs: { level: { default: 1 } },
    // 每个标签一条常量属性规则，因此不需要 getAttrs 这类可执行钩子。
    parseDOM: [
      { tag: "h1", attrs: { level: 1 } },
      { tag: "h2", attrs: { level: 2 } },
      { tag: "h3", attrs: { level: 3 } },
      { tag: "h4", attrs: { level: 4 } },
    ],
    toDOM: (node) => [headingTag(node.attrs.level), 0],
  },

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
  },

  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
  },

  code_block: {
    content: "text*",
    group: "block",
    // 代码块内不接受任何标记，粘贴一律纯文本（方案 §4.2）。
    marks: "",
    code: true,
    defining: true,
    whitespace: "pre",
    parseDOM: [{ tag: "pre", preserveWhitespace: "full" }],
    toDOM: () => ["pre", ["code", 0]],
  },

  bullet_list: {
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
  },
  ordered_list: {
    content: "list_item+",
    group: "block",
    attrs: { start: { default: 1 } },
    parseDOM: [{ tag: "ol" }],
    toDOM: (node) =>
      node.attrs.start === 1 ? ["ol", 0] : ["ol", { start: String(node.attrs.start) }, 0],
  },
  /** `paragraph block*` 是列表项能拆分、能嵌套子列表的前提。 */
  list_item: {
    content: "paragraph block*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: () => ["li", 0],
  },

  // 待办列表用 data 属性区分，优先级高于普通 ul/li，否则会先被无序列表吃掉。
  task_list: {
    content: "task_item+",
    group: "block",
    parseDOM: [{ tag: 'ul[data-type="task-list"]', priority: 60 }],
    toDOM: () => ["ul", { "data-type": "task-list" }, 0],
  },
  task_item: {
    content: "paragraph block*",
    defining: true,
    attrs: { checked: { default: false } },
    parseDOM: [
      { tag: 'li[data-checked="true"]', attrs: { checked: true }, priority: 61 },
      { tag: "li[data-checked]", attrs: { checked: false }, priority: 60 },
    ],
    // 勾选框由 CSS 画：`toDOM` 只能返回纯数据，可交互的复选框需要 NodeView，
    // 那是后续切片的事；勾选走 `list.toggleChecked` 命令。
    toDOM: (node) => ["li", { "data-checked": node.attrs.checked === true ? "true" : "false" }, 0],
  },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
  },

  /**
   * 未知内容兜底。`attrs.original` 原样保存被替换节点的完整 JSON（含子树），
   * 保存时原样写回，因此缺插件或插件降级永不丢用户内容（方案 §9.3）。
   */
  [UNKNOWN_BLOCK]: {
    group: "block",
    atom: true,
    // 不接受任何标记：否则选区加粗会让占位在 DOM 上变粗，而保存时标记又被丢弃，
    // 造成所见不等于所存。
    marks: "",
    attrs: { nodeName: {}, original: {} },
    toDOM: (node) => unknownPlaceholder("div", node),
  },
  [UNKNOWN_INLINE]: {
    group: "inline",
    inline: true,
    atom: true,
    marks: "",
    attrs: { nodeName: {}, original: {} },
    toDOM: (node) => unknownPlaceholder("span", node),
  },
};

/** 冻结核心标记集。 */
export const coreMarks: Record<string, CoreMarkSpec> = {
  strong: {
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
    toDOM: () => ["strong", 0],
  },
  em: {
    parseDOM: [{ tag: "em" }, { tag: "i" }],
    toDOM: () => ["em", 0],
  },
  underline: {
    parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
    toDOM: () => ["u", 0],
  },
  strikethrough: {
    parseDOM: [
      { tag: "s" },
      { tag: "del" },
      { tag: "strike" },
      { style: "text-decoration=line-through" },
    ],
    toDOM: () => ["s", 0],
  },
  code: {
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", 0],
  },
};
