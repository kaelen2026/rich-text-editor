import type {
  DocumentPatch,
  NodeJSON,
  PatchOp,
  VersionLog,
  VersionLogEntry,
} from "@kaelen/editor-shared-types";
import type { Schema } from "prosemirror-model";
import { applyDocumentPatch } from "./document-patch";

/**
 * 版本日志的纯函数操作（S30）。
 *
 * "服务端按 patch 累积版本"用的就是这一组：与 `applyDocumentPatch` 同族，
 * 纯 JS、无 DOM，服务端可以直接调用。函数都是纯的——追加返回新日志对象，
 * 输入的日志与 patch 由调用方持有，这里不拷贝也不改写。
 */

export type VersionLogAppendResult =
  | { ok: true; log: VersionLog }
  | { ok: false; reason: "revision-mismatch"; expectedRevision: number };

export type VersionAtResult =
  | { ok: true; document: NodeJSON }
  | { ok: false; reason: "out-of-range" }
  | { ok: false; reason: "invalid-patch"; detail: string };

export function createVersionLog(baseDoc: NodeJSON, baseRevision = 0): VersionLog {
  return { v: 1, baseRevision, baseDoc, entries: [] };
}

/** 日志能回答的最新修订号。空日志就是基线本身。 */
export function versionLogTip(log: VersionLog): number {
  return log.entries.at(-1)?.patch.to ?? log.baseRevision;
}

/**
 * 追加一条变更。修订号必须与日志末尾严丝合缝——断开的 patch 说明中间丢了
 * 变更（或日志早已过期），接受它会让之后所有版本都重放不出来。
 */
export function appendVersionLogEntry(
  log: VersionLog,
  patch: DocumentPatch,
  meta?: unknown,
): VersionLogAppendResult {
  const tip = versionLogTip(log);
  if (patch.v !== 1 || patch.from !== tip || patch.to <= patch.from) {
    return { ok: false, reason: "revision-mismatch", expectedRevision: tip };
  }
  const entry: VersionLogEntry = meta === undefined ? { patch } : { patch, meta };
  return { ok: true, log: { ...log, entries: [...log.entries, entry] } };
}

/** 从基线重放到指定修订号。基线之前或日志末尾之后的版本号是错误，不去猜。 */
export function documentAtRevision(
  schema: Schema,
  log: VersionLog,
  revision: number,
): VersionAtResult {
  if (revision < log.baseRevision || revision > versionLogTip(log)) {
    return { ok: false, reason: "out-of-range" };
  }
  let document = log.baseDoc;
  let current = log.baseRevision;
  for (const entry of log.entries) {
    if (entry.patch.to > revision) {
      break;
    }
    const applied = applyDocumentPatch(schema, document, entry.patch, current);
    if (!applied.ok) {
      return {
        ok: false,
        reason: "invalid-patch",
        detail: applied.reason === "invalid-patch" ? applied.detail : "修订号断链",
      };
    }
    document = applied.document;
    current = applied.revision;
  }
  return { ok: true, document };
}

/**
 * 把文档从 `fromRevision` 改回 `toRevision` 的逆变更序列（只支持向回走）。
 *
 * 这是"恢复到某个版本"的原料：每条 patch 自带逆操作（§8.4），从新到旧依次
 * 展开即可。恢复因此是**最小 diff** 而不是整篇替换——没被这段历史动过的
 * 内容一步都不挪，压在上面的批注锚点（§9.8）原样存活。
 */
export function inverseOpsBetween(
  log: VersionLog,
  fromRevision: number,
  toRevision: number,
): PatchOp[] | null {
  if (
    toRevision < log.baseRevision ||
    fromRevision > versionLogTip(log) ||
    toRevision >= fromRevision
  ) {
    return null;
  }
  const ops: PatchOp[] = [];
  for (let index = log.entries.length - 1; index >= 0; index -= 1) {
    const entry = log.entries[index];
    if (!entry || entry.patch.to > fromRevision) {
      continue;
    }
    if (entry.patch.to <= toRevision) {
      break;
    }
    ops.push(...entry.patch.inverse);
  }
  return ops;
}
