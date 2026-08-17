import {
  documentAtRevision,
  inverseOpsBetween,
  patchOpToSteps,
  type SessionBridge,
  type SessionExtension,
  versionLogTip,
} from "@kaelen/editor-pm-adapter";
import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import type { VersionLog } from "@kaelen/editor-shared-types";
import { closeHistory } from "prosemirror-history";
import { Node as ProseMirrorNode } from "prosemirror-model";

/**
 * 可选版本历史能力（S30）：`version.restore` 把文档恢复到版本日志里的某个修订号。
 *
 * **恢复是追加一笔把内容改回去的新变更，不是回退历史指针。** 协同下没有
 * "回退"这回事——别人的后续编辑还挂在后面；追加一笔反向变更是唯一能和 S28
 * 共存的语义，而且它自身也可被撤销。反向变更取自日志里每条 patch 自带的
 * `inverse`（§8.4），从新到旧依次应用——**最小 diff 而不是整篇替换**，
 * 没被这段历史动过的内容一步不挪，压在上面的批注锚点（§9.8）原样存活。
 *
 * 查看与对比版本不经过编辑器：那是对版本日志的纯重放
 * （`documentAtRevision`），宿主直接调用即可。本插件只负责唯一要动文档的
 * 动作。它不贡献任何节点或标记，卸载即恢复原状。
 */
export function createVersionHistoryPlugin(): EditorPlugin {
  const controller = new VersionHistoryController();
  return {
    // 命令按插件名做前缀（§9.2），因此插件名取 `version`，命令是 `version.*`。
    name: "version",
    version: "1.0.0",
    namespace: "co_",
    registerCommands: (commands) => {
      commands.add("version.restore", controller.restoreCommand);
    },
    createSessionExtensions: () => [controller],
  };
}

interface RestoreInput {
  history: VersionLog;
  revision: number;
}

class VersionHistoryController implements SessionExtension {
  private bridge: SessionBridge | undefined;

  plugins(): readonly [] {
    return [];
  }

  bind(bridge: SessionBridge): void {
    this.bridge = bridge;
  }

  destroy(): void {
    this.bridge = undefined;
  }

  readonly restoreCommand: SessionCommand = {
    run: (_session, apply, rawInput) => {
      const bridge = this.bridge;
      if (!bridge) {
        return { ok: false, reason: "disabled", detail: "编辑器尚未就绪" };
      }
      const input = restoreInputFrom(rawInput);
      if (!input) {
        return { ok: false, reason: "invalid", detail: "需要 history（版本日志）与 revision" };
      }
      const { history, revision } = input;
      const tip = versionLogTip(history);
      if (revision === tip) {
        return { ok: false, reason: "invalid", detail: "文档已在该版本" };
      }
      const ops = inverseOpsBetween(history, tip, revision);
      if (!ops) {
        return { ok: false, reason: "invalid", detail: "版本号不在日志范围内" };
      }
      if (!apply) {
        return { ok: true };
      }

      const state = bridge.getState();
      const target = documentAtRevision(state.schema, history, revision);
      if (!target.ok) {
        return { ok: false, reason: "invalid", detail: "版本日志无法重放到该版本" };
      }
      const transaction = state.tr;
      for (const op of ops) {
        for (const step of stepsOf(state.schema, transaction, op)) {
          if (step === null || transaction.maybeStep(step).failed !== null) {
            return { ok: false, reason: "invalid", detail: "版本日志与当前文档对不上" };
          }
        }
      }
      // 派发前全等校验（切片的验收条款）：反向变更的结果必须与目标版本
      // 一字不差。对不上宁可拒绝也不派发——错误的"恢复"比不恢复更糟。
      if (!ProseMirrorNode.fromJSON(state.schema, target.document).eq(transaction.doc)) {
        return { ok: false, reason: "invalid", detail: "版本日志与当前文档对不上" };
      }
      // 恢复自成一个撤销步：不关组的话，prosemirror-history 会把它并进
      // 500ms 内的上一笔输入，一步撤销退过头。协同下撤销由 Y.UndoManager
      // 接管，这个 meta 落在未安装的插件键上，无害。
      bridge.dispatch(closeHistory(transaction));
      return { ok: true };
    },
    enabled: (_session, rawInput) => {
      if (!this.bridge) {
        return false;
      }
      const input = restoreInputFrom(rawInput);
      if (!input) {
        return false;
      }
      const tip = versionLogTip(input.history);
      return (
        input.revision !== tip && inverseOpsBetween(input.history, tip, input.revision) !== null
      );
    },
    active: () => false,
  };
}

/** `patchOpToSteps` 对缺失位置会抛错；恢复要的是干净拒绝，不是异常。 */
function stepsOf(
  schema: Parameters<typeof patchOpToSteps>[0],
  transaction: { doc: ProseMirrorNode },
  op: Parameters<typeof patchOpToSteps>[2],
): ReturnType<typeof patchOpToSteps> | [null] {
  try {
    return patchOpToSteps(schema, transaction.doc, op);
  } catch {
    return [null];
  }
}

function restoreInputFrom(input: unknown): RestoreInput | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as { history?: unknown; revision?: unknown };
  const history = record.history as VersionLog | undefined;
  if (
    !history ||
    typeof history !== "object" ||
    history.v !== 1 ||
    typeof history.baseRevision !== "number" ||
    !Array.isArray(history.entries) ||
    typeof record.revision !== "number" ||
    !Number.isInteger(record.revision)
  ) {
    return null;
  }
  return { history, revision: record.revision };
}
