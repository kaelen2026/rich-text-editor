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

/**
 * 冻结核心节点集：不带命名空间前缀，永不改名（方案 §9.2）。
 * S1 只包含最小可编辑闭环需要的三个；后续切片按冻结集清单增补。
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
};
