import type { DocumentMigration, EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";
import { ENVELOPE_VERSION, SCHEMA_VERSION } from "./envelope";

export type MigrateResult =
  | { ok: true; envelope: EditorEnvelope; migrated: boolean }
  | { ok: false; errors: string[] };

/**
 * 把任意来源的输入归一化为当前信封格式。
 *
 * 支持两种输入：已是信封的文档，以及**没有信封的裸文档节点**——后者是版本化
 * 之前的历史数据与手写 JSON，视为最早的 schemaVersion 处理（方案 §12.2）。
 */
export function migrateEnvelope(
  input: EditorEnvelope | NodeJSON,
  migrations: DocumentMigration[] = [],
): MigrateResult {
  const normalized = normalize(input);
  if (!normalized) {
    return { ok: false, errors: ["无法识别的文档格式：既不是信封也不是文档节点"] };
  }

  const target = targetVersion(migrations);
  let envelope = normalized.envelope;
  let migrated = normalized.migrated;

  if (envelope.schemaVersion > target) {
    return {
      ok: false,
      errors: [
        `文档结构版本 ${envelope.schemaVersion} 高于本环境支持的 ${target}：请升级应用后再打开`,
      ],
    };
  }

  const steps = migrations
    .filter((migration) => migration.to > envelope.schemaVersion)
    .sort((left, right) => left.to - right.to);

  for (const step of steps) {
    if (step.to !== envelope.schemaVersion + 1) {
      return {
        ok: false,
        errors: [`迁移链缺口：缺少升级到 ${envelope.schemaVersion + 1} 的步骤`],
      };
    }
    try {
      // 迁移函数是外部代码（平台或插件），抛错不能穿到宿主：装载必须返回结果而非异常。
      envelope = { ...step.up(envelope), schemaVersion: step.to };
    } catch (error) {
      return {
        ok: false,
        errors: [`迁移到版本 ${step.to} 失败：${describe(error)}`],
      };
    }
    migrated = true;
  }

  if (envelope.schemaVersion !== target) {
    return {
      ok: false,
      errors: [`迁移链缺口：文档停在 ${envelope.schemaVersion}，目标版本是 ${target}`],
    };
  }

  return { ok: true, envelope, migrated };
}

/**
 * 目标版本取平台常量与已注册迁移的最大 `to`。平台每加一步迁移就同步抬高
 * `SCHEMA_VERSION`，两者一致；插件贡献的迁移则由此纳入目标。
 */
export function targetVersion(migrations: DocumentMigration[]): number {
  return migrations.reduce((max, migration) => Math.max(max, migration.to), SCHEMA_VERSION);
}

/** 迁移必须声明可逆性：要么给 down，要么显式标 irreversible（方案 §12.2）。 */
export function assertMigrationsDeclareReversibility(migrations: DocumentMigration[]): void {
  const undeclared = migrations
    .filter((migration) => migration.down === undefined && migration.irreversible !== true)
    .map((migration) => migration.to);
  if (undeclared.length > 0) {
    throw new Error(
      `迁移未声明可逆性（缺 down 或 irreversible）：升级到版本 ${undeclared.join("、")}`,
    );
  }
}

interface Normalized {
  envelope: EditorEnvelope;
  migrated: boolean;
}

function normalize(input: EditorEnvelope | NodeJSON): Normalized | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }

  if (isEnvelopeShaped(input)) {
    const plugins = input.plugins ?? {};
    const annotations = input.annotations ?? [];
    const migrated = input.plugins === undefined || input.annotations === undefined;
    return {
      envelope: {
        envelope: input.envelope,
        schemaVersion: input.schemaVersion,
        plugins,
        annotations,
        doc: input.doc,
      },
      migrated,
    };
  }

  if ("type" in input && input.type === "doc") {
    return {
      envelope: {
        envelope: ENVELOPE_VERSION,
        // 裸文档来自版本化之前，按最早版本处理再走迁移链。
        schemaVersion: 1,
        plugins: {},
        annotations: [],
        doc: input,
      },
      migrated: true,
    };
  }

  return null;
}

type PartialEnvelope = Omit<EditorEnvelope, "plugins" | "annotations"> &
  Partial<Pick<EditorEnvelope, "plugins" | "annotations">>;

function isEnvelopeShaped(input: object): input is PartialEnvelope {
  return (
    "envelope" in input &&
    typeof (input as PartialEnvelope).envelope === "number" &&
    "doc" in input &&
    typeof (input as PartialEnvelope).doc === "object"
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
