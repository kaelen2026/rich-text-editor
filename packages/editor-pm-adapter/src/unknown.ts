import { UNKNOWN_BLOCK, UNKNOWN_INLINE } from "@kaelen/editor-schema";
import type { NodeJSON } from "@kaelen/editor-shared-types";
import type { Schema } from "prosemirror-model";

export interface SanitizeResult {
  doc: NodeJSON;
  /** 被兜底的节点名，按文档顺序去重。 */
  unknownNodes: string[];
}

/**
 * 把 Schema 里不存在的节点替换为兜底节点，原节点 JSON 整棵存进
 * `attrs.original`。这样"缺插件"退化为只读展示，而不是整篇文档打不开（方案 §9.3）。
 */
export function sanitizeDoc(schema: Schema, doc: NodeJSON): SanitizeResult {
  const unknownNodes: string[] = [];
  const sanitized = sanitizeNode(schema, doc, null, unknownNodes);
  return { doc: sanitized, unknownNodes };
}

/** `sanitizeDoc` 的逆操作：把兜底节点还原成它保存的原始 JSON。 */
export function restoreDoc(doc: NodeJSON): NodeJSON {
  if (doc.type === UNKNOWN_BLOCK || doc.type === UNKNOWN_INLINE) {
    return doc.attrs?.original as NodeJSON;
  }
  const restored: NodeJSON = { type: doc.type };
  if (doc.attrs !== undefined) {
    restored.attrs = doc.attrs;
  }
  if (doc.content !== undefined) {
    restored.content = doc.content.map(restoreDoc);
  }
  if (doc.marks !== undefined) {
    restored.marks = doc.marks;
  }
  if (doc.text !== undefined) {
    restored.text = doc.text;
  }
  return restored;
}

function sanitizeNode(
  schema: Schema,
  node: NodeJSON,
  parentType: string | null,
  unknownNodes: string[],
): NodeJSON {
  if (!schema.nodes[node.type]) {
    if (!unknownNodes.includes(node.type)) {
      unknownNodes.push(node.type);
    }
    return {
      type: prefersInline(schema, parentType) ? UNKNOWN_INLINE : UNKNOWN_BLOCK,
      attrs: { nodeName: node.type, original: node },
    };
  }

  const sanitized: NodeJSON = { type: node.type };
  if (node.attrs !== undefined) {
    sanitized.attrs = node.attrs;
  }
  if (node.content !== undefined) {
    sanitized.content = node.content.map((child) =>
      sanitizeNode(schema, child, node.type, unknownNodes),
    );
  }
  if (node.marks !== undefined) {
    // 未知标记直接丢弃标记，但保留它覆盖的文本。
    const known = node.marks.filter((mark) => schema.marks[mark.type] !== undefined);
    if (known.length > 0) {
      sanitized.marks = known;
    }
  }
  if (node.text !== undefined) {
    sanitized.text = node.text;
  }
  return sanitized;
}

/** 父节点接受行内内容时用行内兜底，否则用块级兜底。 */
function prefersInline(schema: Schema, parentType: string | null): boolean {
  if (!parentType) {
    return false;
  }
  const parent = schema.nodes[parentType];
  const inlineFallback = schema.nodes[UNKNOWN_INLINE];
  if (!parent || !inlineFallback) {
    return false;
  }
  return parent.contentMatch.matchType(inlineFallback) !== null;
}
