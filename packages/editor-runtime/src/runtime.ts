import { buildSchema, coreCommands, EditorSession } from "@kaelen/editor-pm-adapter";
import { createEmptyEnvelope, validateEnvelope } from "@kaelen/editor-schema";
import type {
  CommandQuery,
  CommandResult,
  EditorEnvelope,
  EditorEventName,
  EditorSnapshot,
  LoadResult,
} from "@kaelen/editor-shared-types";
import { collectPluginCapabilities, type EditorPlugin } from "./plugins";

export interface Runtime {
  loadDocument(envelope: EditorEnvelope): LoadResult;
  getDocument(): EditorEnvelope;
  execute(command: string, input?: unknown): CommandResult;
  queryCommand(command: string): CommandQuery;
  getSnapshot(): EditorSnapshot;
  subscribe(event: EditorEventName, listener: () => void): () => void;
  isDirty(): boolean;
  markSaved(): void;
  getRevision(): number;
  undo(): CommandResult;
  redo(): CommandResult;
  mount(element: HTMLElement): void;
  unmount(): void;
  destroy(): void;
  focus(): void;
}

/** 信封中除文档体以外的部分：装载时记住，取回时原样带出。 */
type EnvelopeMeta = Omit<EditorEnvelope, "doc">;

export interface RuntimeOptions {
  plugins?: EditorPlugin[];
}

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const capabilities = collectPluginCapabilities(options.plugins ?? []);
  const schema = buildSchema({ nodes: capabilities.nodes, marks: capabilities.marks });
  const initial = createEmptyEnvelope();
  const commands = new Map([...Object.entries(coreCommands), ...capabilities.commands]);

  let meta = toMeta(initial);
  let revision = 0;
  let stateRevision = 0;
  let dirty = false;
  let destroyed = false;
  let snapshot: EditorSnapshot | null = null;
  const listeners = new Map<EditorEventName, Set<() => void>>();

  function emit(event: EditorEventName): void {
    for (const listener of listeners.get(event) ?? []) {
      listener();
    }
  }

  function invalidate(): void {
    stateRevision += 1;
    snapshot = null;
    emit("change");
  }

  const session = new EditorSession(schema, initial.doc, (docChanged) => {
    if (docChanged) {
      revision += 1;
      dirty = true;
    }
    invalidate();
  });

  return {
    loadDocument(envelope: EditorEnvelope): LoadResult {
      const errors = validateEnvelope(envelope);
      if (errors.length > 0) {
        return { ok: false, degraded: false, unknownNodes: [], errors };
      }
      let unknownNodes: string[];
      try {
        unknownNodes = session.replaceDoc(envelope.doc);
      } catch (error) {
        return { ok: false, degraded: false, unknownNodes: [], errors: [describe(error)] };
      }
      meta = toMeta(envelope);
      // 装载是初始化，不是用户编辑：修订号与脏标记归零。
      revision = 0;
      dirty = false;
      invalidate();
      if (unknownNodes.length > 0) {
        emit("documentDegraded");
      }
      return { ok: true, degraded: unknownNodes.length > 0, unknownNodes };
    },

    getDocument(): EditorEnvelope {
      return { ...meta, doc: session.docJSON };
    },

    execute(command: string, input?: unknown): CommandResult {
      if (destroyed) {
        return { ok: false, reason: "destroyed" };
      }
      const spec = commands.get(command);
      if (!spec) {
        return { ok: false, reason: "disabled", detail: `未注册的命令：${command}` };
      }
      return spec.run(session, true, input);
    },

    queryCommand(command: string): CommandQuery {
      const spec = commands.get(command);
      if (destroyed || !spec) {
        return { enabled: false, active: false };
      }
      return {
        enabled: spec.enabled?.(session) ?? spec.run(session, false).ok,
        active: spec.active(session),
      };
    },

    getSnapshot(): EditorSnapshot {
      if (!snapshot) {
        snapshot = { revision, stateRevision, dirty, mounted: session.mounted };
      }
      return snapshot;
    },

    subscribe(event: EditorEventName, listener: () => void): () => void {
      const bucket = listeners.get(event) ?? new Set<() => void>();
      bucket.add(listener);
      listeners.set(event, bucket);
      return () => {
        bucket.delete(listener);
      };
    },

    isDirty(): boolean {
      return dirty;
    },

    /** 宿主完成持久化后清除脏标记。与装载不同：不重建状态，撤销历史保留。 */
    markSaved(): void {
      if (!dirty) {
        return;
      }
      dirty = false;
      invalidate();
    },

    getRevision(): number {
      return revision;
    },

    undo(): CommandResult {
      return this.execute("history.undo");
    },

    redo(): CommandResult {
      return this.execute("history.redo");
    },

    mount(element: HTMLElement): void {
      if (destroyed || session.mounted) {
        return;
      }
      session.mount(element);
      invalidate();
    },

    unmount(): void {
      if (!session.mounted) {
        return;
      }
      session.unmount();
      invalidate();
    },

    /** 销毁实例。与 unmount 正交：销毁由创建者负责，卸载由框架适配层负责。 */
    destroy(): void {
      session.unmount();
      destroyed = true;
      invalidate();
    },

    focus(): void {
      session.focus();
    },
  };
}

function toMeta(envelope: EditorEnvelope): EnvelopeMeta {
  return {
    envelope: envelope.envelope,
    schemaVersion: envelope.schemaVersion,
    plugins: { ...envelope.plugins },
    annotations: [...envelope.annotations],
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
