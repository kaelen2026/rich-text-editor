import { cloneJson, UNKNOWN_BLOCK, UNKNOWN_INLINE } from "@kaelen/editor-schema";
import type { NodeJSON } from "@kaelen/editor-shared-types";
import type { Schema } from "prosemirror-model";

export interface SanitizeResult {
  doc: NodeJSON;
  /** 被兜底的节点名，按文档顺序去重。 */
  unknownNodes: string[];
  /** 被丢弃的未知标记名，按文档顺序去重。文本保留，格式丢失。 */
  unknownMarks: string[];
}

/**
 * 把 Schema 里不存在的节点替换为兜底节点，原节点 JSON 整棵存进
 * `attrs.original`。这样"缺插件"退化为只读展示，而不是整篇文档打不开（方案 §9.3）。
 */
export function sanitizeDoc(schema: Schema, doc: NodeJSON): SanitizeResult {
  const unknownNodes: string[] = [];
  const unknownMarks: string[] = [];
  const sanitized = sanitizeNode(schema, doc, null, unknownNodes, unknownMarks);
  return { doc: sanitized, unknownNodes, unknownMarks };
}

/** `sanitizeDoc` 的逆操作：把兜底节点还原成它保存的原始 JSON。 */
export function restoreDoc(doc: NodeJSON): NodeJSON {
  if (doc.type === UNKNOWN_BLOCK || doc.type === UNKNOWN_INLINE) {
    // 同样深拷贝：调用方改写取回的文档，不能污染编辑器内部状态。
    return cloneJson(doc.attrs?.original) as NodeJSON;
  }
  const restored: NodeJSON = { type: doc.type };
  if (doc.attrs !== undefined) {
    // ProseMirror 的 Node.toJSON 把活节点的 attrs 按引用交出来，这里必须切断。
    restored.attrs = cloneJson(doc.attrs);
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
  unknownMarks: string[],
): NodeJSON {
  if (!schema.nodes[node.type]) {
    if (!unknownNodes.includes(node.type)) {
      unknownNodes.push(node.type);
    }
    return {
      type: prefersInline(schema, parentType) ? UNKNOWN_INLINE : UNKNOWN_BLOCK,
      // 深拷贝：兜底节点保存的是快照，不是调用方对象的引用。否则调用方之后
      // 改自己那份 JSON，就会改到编辑器里已装载的内容。
      attrs: { nodeName: node.type, original: cloneJson(node) },
    };
  }

  const sanitized: NodeJSON = { type: node.type };
  if (node.attrs !== undefined) {
    // 已知节点的 attrs 同样要隔离：输入可能本身就是兜底形态，此时 attrs.original
    // 走的是这条分支。
    sanitized.attrs = cloneJson(node.attrs);
  }
  if (node.content !== undefined) {
    sanitized.content = node.content.map((child) =>
      sanitizeNode(schema, child, node.type, unknownNodes, unknownMarks),
    );
  }
  if (node.marks !== undefined) {
    // 未知标记直接丢弃标记，但保留它覆盖的文本；丢弃要上报，否则宿主无从提示。
    for (const mark of node.marks) {
      if (schema.marks[mark.type] === undefined && !unknownMarks.includes(mark.type)) {
        unknownMarks.push(mark.type);
      }
    }
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
