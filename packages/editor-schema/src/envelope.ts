import type {
  Annotation,
  EditorDocumentInput,
  EditorEnvelope,
  MarkJSON,
  NodeJSON,
} from "@kaelen/editor-shared-types";

/** 信封结构自身的版本。 */
export const ENVELOPE_VERSION = 1;

/** 平台级文档结构版本，单调递增，驱动迁移链。 */
export const SCHEMA_VERSION = 1;

/** 单个 schema 版本升级步骤。迁移函数必须是纯函数，且不得改写未知节点。 */
export interface SchemaMigration {
  from: number;
  to: number;
  /** 缺少反向函数时必须显式标记为不可逆。 */
  reversible: boolean;
  migrate: (envelope: EditorEnvelope) => EditorEnvelope;
}

export type MigrationResult =
  | { ok: true; migrated: boolean; envelope: EditorEnvelope }
  | { ok: false; migrated: false; errors: string[] };

/**
 * v0 只存在裸 ProseMirror doc；v1 才引入版本化信封。
 * 包装后无法从信封本身辨别原始输入是否为裸 doc，因此该步骤不可逆。
 */
export const schemaMigrations: readonly SchemaMigration[] = [
  {
    from: 0,
    to: 1,
    reversible: false,
    migrate: (envelope) => ({
      ...envelope,
      schemaVersion: 1,
      plugins: { ...envelope.plugins },
      annotations: [...envelope.annotations],
      // `doc` 整棵树按引用透传；未知节点及其 attrs/content 不参与本次迁移。
      doc: envelope.doc,
    }),
  },
];

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
  if (!Number.isSafeInteger(envelope.schemaVersion) || (envelope.schemaVersion ?? -1) < 0) {
    errors.push("schemaVersion 必须是非负整数");
  }
  if (typeof envelope.doc !== "object" || envelope.doc === null) {
    errors.push("doc 必须是对象");
  } else if (envelope.doc.type !== "doc") {
    errors.push(`顶层节点必须是 doc，实际是 ${String(envelope.doc.type)}`);
  }
  return errors;
}

/**
 * 读取路径的统一入口。裸 doc 被视为 schema v0，再按版本号逐步迁移到当前版本。
 * 每一步仅返回新信封，不修改调用方传入的对象。
 */
export function migrateDocument(input: EditorDocumentInput): MigrationResult {
  let envelope = toMigrationEnvelope(input);
  const errors = validateEnvelope(envelope);
  if (errors.length > 0) {
    return { ok: false, migrated: false, errors };
  }
  if (envelope.schemaVersion > SCHEMA_VERSION) {
    return {
      ok: false,
      migrated: false,
      errors: [`文档 schemaVersion ${envelope.schemaVersion} 高于当前支持版本 ${SCHEMA_VERSION}`],
    };
  }

  let migrated = false;
  while (envelope.schemaVersion < SCHEMA_VERSION) {
    const migration = schemaMigrations.find((step) => step.from === envelope.schemaVersion);
    if (!migration) {
      return {
        ok: false,
        migrated: false,
        errors: [`缺少 schemaVersion ${envelope.schemaVersion} 的迁移步骤`],
      };
    }
    envelope = migration.migrate(envelope);
    migrated = true;
  }

  return { ok: true, migrated, envelope };
}

function toMigrationEnvelope(input: EditorDocumentInput): EditorEnvelope {
  if (isBareDocument(input)) {
    return {
      envelope: ENVELOPE_VERSION,
      schemaVersion: 0,
      plugins: {},
      doc: input,
      annotations: [],
    };
  }
  return input;
}

function isBareDocument(input: EditorDocumentInput): input is NodeJSON {
  return typeof input === "object" && input !== null && "type" in input && input.type === "doc";
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
