import type { CoreMarkSpec, CoreNodeSpec } from "@kaelen/editor-shared-types";

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
