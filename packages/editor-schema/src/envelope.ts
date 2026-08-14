import type { Annotation, EditorEnvelope, MarkJSON, NodeJSON } from "@kaelen/editor-shared-types";

/** 信封结构自身的版本。 */
export const ENVELOPE_VERSION = 1;

/** 平台级文档结构版本，单调递增，驱动迁移链。 */
export const SCHEMA_VERSION = 1;

export function createEmptyEnvelope(): EditorEnvelope {
  return {
    envelope: ENVELOPE_VERSION,
    schemaVersion: SCHEMA_VERSION,
    plugins: {},
    doc: { type: "doc", content: [{ type: "paragraph" }] },
    annotations: [],
  };
}

export function validateEnvelope(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null) {
    return ["信封必须是对象"];
  }
  const envelope = value as Partial<EditorEnvelope>;
  if (envelope.envelope !== ENVELOPE_VERSION) {
    errors.push(`不支持的信封版本：${String(envelope.envelope)}`);
  }
  if (typeof envelope.schemaVersion !== "number") {
    errors.push("schemaVersion 必须是数字");
  }
  if (typeof envelope.doc !== "object" || envelope.doc === null) {
    errors.push("doc 必须是对象");
  } else if (envelope.doc.type !== "doc") {
    errors.push(`顶层节点必须是 doc，实际是 ${String(envelope.doc.type)}`);
  }
  return errors;
}

/**
 * 规范化序列化：键顺序固定，因此同一份文档在任何环境下产出同样的字节。
 * 存储与比对都以此为准。
 */
export function stringifyEnvelope(envelope: EditorEnvelope): string {
  return JSON.stringify(canonicalEnvelope(envelope), null, 2);
}

function canonicalEnvelope(envelope: EditorEnvelope): Record<string, unknown> {
  return {
    envelope: envelope.envelope,
    schemaVersion: envelope.schemaVersion,
    plugins: canonicalPlugins(envelope.plugins),
    doc: canonicalNode(envelope.doc),
    annotations: envelope.annotations.map(canonicalAnnotation),
  };
}

function canonicalPlugins(plugins: Record<string, number>): Record<string, number> {
  const ordered: Record<string, number> = {};
  for (const name of Object.keys(plugins).sort()) {
    const version = plugins[name];
    if (version !== undefined) {
      ordered[name] = version;
    }
  }
  return ordered;
}

function canonicalNode(node: NodeJSON): Record<string, unknown> {
  const ordered: Record<string, unknown> = { type: node.type };
  if (node.attrs !== undefined) {
    ordered.attrs = node.attrs;
  }
  if (node.content !== undefined) {
    ordered.content = node.content.map(canonicalNode);
  }
  if (node.marks !== undefined) {
    ordered.marks = node.marks.map(canonicalMark);
  }
  if (node.text !== undefined) {
    ordered.text = node.text;
  }
  return ordered;
}

function canonicalMark(mark: MarkJSON): Record<string, unknown> {
  const ordered: Record<string, unknown> = { type: mark.type };
  if (mark.attrs !== undefined) {
    ordered.attrs = mark.attrs;
  }
  return ordered;
}

function canonicalAnnotation(annotation: Annotation): Record<string, unknown> {
  return {
    id: annotation.id,
    from: annotation.from,
    to: annotation.to,
    orphaned: annotation.orphaned,
    payload: annotation.payload,
  };
}
