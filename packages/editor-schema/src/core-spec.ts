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
 * 代码块的语言标识。取值是开放集合（高亮器认识什么就是什么），因此用字符
 * 白名单而不是枚举：语言名会进 `class` 属性，放行任意字符串等于让文档内容
 * 决定标签结构。首字符必须是字母，其余允许 `c++`、`c#`、`objective-c` 这类
 * 真实存在的写法。
 */
const CODE_LANGUAGE_PATTERN = /^[a-z][a-z0-9+#._-]{0,31}$/;

export function isCodeLanguage(value: unknown): value is string {
  return typeof value === "string" && CODE_LANGUAGE_PATTERN.test(value);
}

/**
 * 文本块的水平对齐。`null` 是"没有设置"，与"设成左对齐"不是一回事：
 * 前者跟随容器（阿拉伯语等 RTL 文档里就是右起），后者钉死在左边。
 */
export const BLOCK_ALIGNMENTS = ["left", "center", "right", "justify"] as const;
export type BlockAlign = (typeof BLOCK_ALIGNMENTS)[number];

export function isBlockAlign(value: unknown): value is BlockAlign {
  return typeof value === "string" && (BLOCK_ALIGNMENTS as readonly string[]).includes(value);
}

/** 供 `parseDOM` 复用的声明式读取规则：白名单之外的值一律当作没设置。 */
const ALIGN_FROM_DOM = {
  align: { attribute: "data-align", oneOf: BLOCK_ALIGNMENTS, default: null },
} as const;

/**
 * 对齐的 DOM 表达。同时写 `style` 与 `data-align`：前者让 `getHTML()` 导出的
 * 内容脱离本项目样式表也保真，后者是重新解析时的唯一入口——`style` 属性不参与
 * 节点解析（可执行的样式串不该决定文档结构）。
 *
 * 没设置对齐时返回空数组，`toDOM` 因此输出与从前逐字节相同的 `<p>`：
 * 绝大多数段落不该为一个未使用的功能付出属性体积。
 */
function alignAttributes(align: unknown): [Record<string, string>] | [] {
  return isBlockAlign(align) ? [{ style: `text-align:${align}`, "data-align": align }] : [];
}

/**
 * 代码块的 DOM 表达。语言写两处：`data-language` 供重新解析，`class` 供高亮器
 * 与外部应用识别。没设置语言时输出与从前逐字节相同的 `<pre><code>`——绝大多数
 * 代码块不该为一个未使用的属性付出体积。文档里的非法语言在这里被当作没设置，
 * 而不是原样拼进标签。
 */
function codeBlockDOM(language: unknown): DomOutputSpec {
  if (!isCodeLanguage(language)) {
    return ["pre", ["code", 0]];
  }
  return ["pre", { "data-language": language }, ["code", { class: `language-${language}` }, 0]];
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
    attrs: { align: { default: null } },
    parseDOM: [{ tag: "p", attrsFromDOM: ALIGN_FROM_DOM }],
    toDOM: (node) => ["p", ...alignAttributes(node.attrs.align), 0],
  },
  text: { group: "inline" },

  heading: {
    content: "inline*",
    group: "block",
    defining: true,
    attrs: { level: { default: 1 }, align: { default: null } },
    // 层级仍是每个标签一条常量规则；对齐是声明式的属性映射，两者都不需要
    // getAttrs 这类可执行钩子。
    parseDOM: [
      { tag: "h1", attrs: { level: 1 }, attrsFromDOM: ALIGN_FROM_DOM },
      { tag: "h2", attrs: { level: 2 }, attrsFromDOM: ALIGN_FROM_DOM },
      { tag: "h3", attrs: { level: 3 }, attrsFromDOM: ALIGN_FROM_DOM },
      { tag: "h4", attrs: { level: 4 }, attrsFromDOM: ALIGN_FROM_DOM },
    ],
    toDOM: (node) => [headingTag(node.attrs.level), ...alignAttributes(node.attrs.align), 0],
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
    attrs: { language: { default: null } },
    // `data-language` 是自有输出的入口，`class="language-x"` 是外部高亮器的
    // 通行写法；两条都只读一个白名单化的 token，非法值当作没设置。
    parseDOM: [
      {
        tag: "pre[data-language]",
        preserveWhitespace: "full",
        attrsFromDOM: {
          language: { attribute: "data-language", type: "token", default: null },
        },
      },
      {
        tag: "pre[class]",
        preserveWhitespace: "full",
        attrsFromDOM: {
          language: { attribute: "class", type: "token", prefix: "language-", default: null },
        },
      },
      { tag: "pre", preserveWhitespace: "full" },
    ],
    toDOM: (node) => codeBlockDOM(node.attrs.language),
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
