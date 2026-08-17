import type {
  CoreMarkdownParseRule,
  CoreMarkSpec,
  CoreNodeSpec,
  CoreNodeView,
  DomOutputSpec,
  NodeJSON,
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
 * 标题的 Markdown 解析规则。和 `parseDOM` 一样每个标签一条常量规则，不需要
 * 从标签名里算层级的钩子。`h5`/`h6` 归到 `h4`——与 §11.3 的外部 HTML 降级
 * 同一条规则，两条导入路径不该给出不同的结构。
 */
const HEADING_FROM_MARKDOWN: CoreMarkdownParseRule[] = [
  { token: "heading", tag: "h1", attrs: { level: 1 } },
  { token: "heading", tag: "h2", attrs: { level: 2 } },
  { token: "heading", tag: "h3", attrs: { level: 3 } },
  { token: "heading", tag: "h4", attrs: { level: 4 } },
  { token: "heading", tag: "h5", attrs: { level: 4 } },
  { token: "heading", tag: "h6", attrs: { level: 4 } },
];

/**
 * 围栏长度必须超过内容里最长的一串反引号，否则代码里出现 ` ``` ` 就会把围栏
 * 提前收掉，后半段代码变成正文。代码块的下限是三个（CommonMark 规定），
 * 行内代码跨的下限是一个。
 */
function fenceFor(text: string, minimum: number): string {
  const longest = [...text.matchAll(/`+/g)].reduce((max, [run]) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(minimum, longest + 1));
}

/** 代码块的正文：内容只可能是文本节点（`content: "text*"`）。 */
function codeText(content: readonly NodeJSON[]): string {
  return content.map((child) => child.text ?? "").join("");
}

/**
 * 兜底节点导出 Markdown 时取出 `attrs.original` 里的文本。
 *
 * Markdown 里没有"我不认识这个结构"的表达，占位说明语又不是用户写的东西。
 * 因此按 §9.3 的同一条立场处理：丢格式，不丢内容——原始子树的文字照常出现在
 * 导出结果里，结构留在信封里等插件装回来。
 */
function originalText(original: unknown): string {
  if (typeof original !== "object" || original === null) {
    return "";
  }
  const node = original as NodeJSON;
  const own = node.text ?? "";
  const children = (node.content ?? []).map((child) => originalText(child)).join("");
  return own + children;
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
    // 对齐没有 Markdown 表达，导出时丢掉：Markdown 是交换格式，丢的是格式
    // 不是文字，存储格式仍然是信封 JSON（方案 §4.3）。
    toMarkdown: (node, context) => context.inline(node.content),
    fromMarkdown: [{ token: "paragraph" }],
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
    toMarkdown: (node, context) =>
      `${"#".repeat(isHeadingLevel(node.attrs.level) ? node.attrs.level : 1)} ${context.inline(node.content)}`,
    fromMarkdown: HEADING_FROM_MARKDOWN,
  },

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    parseDOM: [{ tag: "blockquote" }],
    toDOM: () => ["blockquote", 0],
    toMarkdown: (node, context) => context.prefixLines(context.blocks(node.content), "> "),
    fromMarkdown: [{ token: "blockquote" }],
  },

  horizontal_rule: {
    group: "block",
    parseDOM: [{ tag: "hr" }],
    toDOM: () => ["hr"],
    // `***` 与 `___` 也是合法分隔线，但 `---` 是重录 fixture 时最不容易看错的
    // 一种，导出只用这一种写法，解析三种都收。
    toMarkdown: () => "---",
    fromMarkdown: [{ token: "hr" }],
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
    toMarkdown: (node) => {
      const text = codeText(node.content).replace(/\n$/, "");
      const fence = fenceFor(text, 3);
      return `${fence}${isCodeLanguage(node.attrs.language) ? node.attrs.language : ""}\n${text}\n${fence}`;
    },
    // `fence` 是围栏写法，`code_block` 是四空格缩进写法；后者没有语言串。
    fromMarkdown: [
      {
        token: "fence",
        attrsFromToken: { language: { from: "info", type: "token", default: null } },
      },
      { token: "code_block" },
    ],
  },

  bullet_list: {
    content: "list_item+",
    group: "block",
    parseDOM: [{ tag: "ul" }],
    toDOM: () => ["ul", 0],
    toMarkdown: (node, context) =>
      node.content.map((item) => context.prefixLines(context.block(item), "- ", "  ")).join("\n"),
    fromMarkdown: [{ token: "bullet_list" }],
  },
  ordered_list: {
    content: "list_item+",
    group: "block",
    attrs: { start: { default: 1 } },
    parseDOM: [{ tag: "ol" }],
    toDOM: (node) =>
      node.attrs.start === 1 ? ["ol", 0] : ["ol", { start: String(node.attrs.start) }, 0],
    toMarkdown: (node, context) => {
      const start = Number.isInteger(node.attrs.start) ? (node.attrs.start as number) : 1;
      return node.content
        .map((item, index) => {
          // 续行缩进要和序号一样宽，否则 `10.` 之后的续行会掉出列表项。
          const marker = `${start + index}. `;
          return context.prefixLines(context.block(item), marker, " ".repeat(marker.length));
        })
        .join("\n");
    },
    fromMarkdown: [
      {
        token: "ordered_list",
        attrsFromToken: {
          start: { from: "attribute", attribute: "start", type: "integer", min: 1, default: 1 },
        },
      },
    ],
  },
  /** `paragraph block*` 是列表项能拆分、能嵌套子列表的前提。 */
  list_item: {
    content: "paragraph block*",
    defining: true,
    parseDOM: [{ tag: "li" }],
    toDOM: () => ["li", 0],
    // 列表标记由父列表加，列表项自己只负责内容：有序和无序的标记宽度不同，
    // 而缩进必须跟着标记宽度走。
    toMarkdown: (node, context) => context.blocks(node.content),
    fromMarkdown: [{ token: "list_item" }],
  },

  // 待办列表用 data 属性区分，优先级高于普通 ul/li，否则会先被无序列表吃掉。
  task_list: {
    content: "task_item+",
    group: "block",
    parseDOM: [{ tag: 'ul[data-type="task-list"]', priority: 60 }],
    toDOM: () => ["ul", { "data-type": "task-list" }, 0],
    toMarkdown: (node, context) =>
      node.content.map((item) => context.prefixLines(context.block(item), "- ", "  ")).join("\n"),
    // `task_list` / `task_item` 不是 markdown-it 的 token：GFM 的复选框只是列表项
    // 正文开头的一段文字。Markdown 包在解析前把带复选框的列表改写成这两个 token，
    // 映射本身因此仍然是声明式的。
    fromMarkdown: [{ token: "task_list" }],
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
    // 复选框只出现在首行，因此续行前缀为空——父列表随后再统一加 `- ` 和缩进。
    toMarkdown: (node, context) =>
      context.prefixLines(
        context.blocks(node.content),
        node.attrs.checked === true ? "[x] " : "[ ] ",
        "",
      ),
    fromMarkdown: [
      {
        token: "task_item",
        attrsFromToken: {
          checked: { from: "attribute", attribute: "checked", type: "boolean", default: false },
        },
      },
    ],
  },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: () => ["br"],
    // 反斜杠换行而不是行尾两个空格：后者在编辑器和 diff 里都看不见，
    // 一次顺手的 trim 就把硬换行改没了。
    toMarkdown: () => "\\\n",
    fromMarkdown: [{ token: "hardbreak" }],
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
    toMarkdown: (node, context) => context.escapeText(originalText(node.attrs.original)),
  },
  [UNKNOWN_INLINE]: {
    group: "inline",
    inline: true,
    atom: true,
    marks: "",
    attrs: { nodeName: {}, original: {} },
    toDOM: (node) => unknownPlaceholder("span", node),
    toMarkdown: (node, context) => context.escapeText(originalText(node.attrs.original)),
  },
};

/** 冻结核心标记集。 */
export const coreMarks: Record<string, CoreMarkSpec> = {
  strong: {
    parseDOM: [{ tag: "strong" }, { tag: "b" }],
    toDOM: () => ["strong", 0],
    toMarkdown: (_mark, content) => `**${content}**`,
    fromMarkdown: [{ token: "strong" }],
  },
  em: {
    parseDOM: [{ tag: "em" }, { tag: "i" }],
    toDOM: () => ["em", 0],
    // `*` 而不是 `_`：下划线在标识符中间不构成强调，`snake_case_word` 一类的
    // 文本会让两种写法的解析结果不一致。
    toMarkdown: (_mark, content) => `*${content}*`,
    fromMarkdown: [{ token: "em" }],
  },
  underline: {
    parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }],
    toDOM: () => ["u", 0],
    // Markdown 没有下划线。刻意不退回 `<u>`：那是把 HTML 塞进 Markdown，
    // 换个渲染器就成了字面量尖括号。按丢格式不丢内容处理（方案 §4.3）。
  },
  strikethrough: {
    parseDOM: [
      { tag: "s" },
      { tag: "del" },
      { tag: "strike" },
      { style: "text-decoration=line-through" },
    ],
    toDOM: () => ["s", 0],
    toMarkdown: (_mark, content) => `~~${content}~~`,
    fromMarkdown: [{ token: "s" }],
  },
  code: {
    parseDOM: [{ tag: "code" }],
    toDOM: () => ["code", 0],
    // 代码跨里没有反斜杠转义，内容一律字面量；反引号只能靠加长围栏来躲，
    // 两端补空格是 CommonMark 规定的写法，解析时会被去掉。
    markdownLiteral: true,
    toMarkdown: (_mark, content) => {
      const fence = fenceFor(content, 1);
      const pad = content.startsWith("`") || content.endsWith("`") ? " " : "";
      return `${fence}${pad}${content}${pad}${fence}`;
    },
    fromMarkdown: [{ token: "code_inline" }],
  },
};
