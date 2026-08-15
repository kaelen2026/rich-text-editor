import {
  buildSchema,
  documentPatchFromTransaction,
  EditorSession,
  type SessionCommand,
} from "@kaelen/editor-pm-adapter";
import {
  assertMigrationsDeclareReversibility,
  cloneJson,
  createEmptyEnvelope,
  migrateEnvelope,
  renderDocumentToHTML,
  validateEnvelope,
} from "@kaelen/editor-schema";
import type {
  ClipboardNotice,
  CommandQuery,
  CommandResult,
  DocumentMigration,
  DocumentPatch,
  EditorEnvelope,
  EditorEventName,
  EditorEventPayload,
  EditorMode,
  EditorSnapshot,
  LoadResult,
  NodeJSON,
  PluginError,
  SelectionSnapshot,
} from "@kaelen/editor-shared-types";
import { type AutoSaveOptions, AutoSaveScheduler } from "./autosave";
import { PluginBreaker } from "./breaker";
import { describeError, type EditorPlugin, resolvePlugins } from "./plugins";

export interface Runtime {
  loadDocument(input: EditorEnvelope | NodeJSON): LoadResult;
  getDocument(): EditorEnvelope;
  /** 从当前结构化文档生成 HTML；与服务端共用纯 JS renderer。 */
  getHTML(): string;
  execute(command: string, input?: unknown): CommandResult;
  queryCommand(command: string, input?: unknown): CommandQuery;
  getMode(): EditorMode;
  setMode(mode: EditorMode): void;
  getSelectionState(): SelectionSnapshot;
  getSnapshot(): EditorSnapshot;
  subscribe<TEvent extends EditorEventName>(
    event: TEvent,
    listener: (payload: EditorEventPayload[TEvent]) => void,
  ): () => void;
  /**
   * 至今为止的全部插件降级记录，含启动期冲突——它们发生在宿主能订阅之前。
   * 没有新记录时返回同一个引用，可直接喂给 `useSyncExternalStore`。
   */
  getPluginErrors(): readonly PluginError[];
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
  /** 文档结构迁移。后续由插件通过注册中心贡献（方案 §8.3）。 */
  migrations?: DocumentMigration[];
  /** 初始三态，默认可编辑（方案 §4.1）。 */
  mode?: EditorMode;
  /** 增量自动保存：2 秒空闲或 50 个 patch 后提交。 */
  autoSave?: AutoSaveOptions;
}

/** 事件载荷在订阅处收敛为具体类型，这里只需要一个能装下所有监听器的形状。 */
type AnyListener = (payload: never) => void;

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const migrations = options.migrations ?? [];
  assertMigrationsDeclareReversibility(migrations);
  const resolution = resolvePlugins(options.plugins ?? []);
  const schema = buildSchema({ nodes: resolution.nodes, marks: resolution.marks });
  const initial = createEmptyEnvelope();
  const commands = resolution.commands;
  const sessionExtensions = resolution.enabled.flatMap(
    (plugin) => plugin.createSessionExtensions?.() ?? [],
  );
  const breaker = new PluginBreaker();

  let meta = toMeta(initial);
  let revision = 0;
  let stateRevision = 0;
  let dirty = false;
  let destroyed = false;
  let snapshot: EditorSnapshot | null = null;
  let documentSnapshot: EditorEnvelope | null = null;
  // 启动期的冲突发生在宿主订阅之前，只能靠 getPluginErrors 取回。
  let pluginErrors: readonly PluginError[] = Object.freeze([...resolution.errors]);
  const listeners = new Map<EditorEventName, Set<AnyListener>>();
  const autoSave = options.autoSave
    ? new AutoSaveScheduler(options.autoSave, (savedRevision) => {
        if (savedRevision === revision && dirty) {
          dirty = false;
          invalidate();
        }
      })
    : undefined;
  let pendingPatch: DocumentPatch | undefined;

  function emit<TEvent extends EditorEventName>(
    event: TEvent,
    payload: EditorEventPayload[TEvent],
  ): void {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (value: EditorEventPayload[TEvent]) => void)(payload);
    }
  }

  function invalidate(): void {
    stateRevision += 1;
    snapshot = null;
    documentSnapshot = null;
    emit("change", undefined);
  }

  /**
   * 插件入口点抛错后的统一收口：状态已由 `runProtected` 回滚到出错前，
   * 这里只负责计数、上报与（达到阈值时）停用（方案 §8.6）。
   */
  function recordPluginFailure(plugin: string, error: unknown): PluginError {
    const tripped = breaker.record(plugin, Date.now());
    const pluginError: PluginError = {
      plugin,
      kind: "runtimeError",
      disabled: true,
      tripped,
      message: tripped
        ? `插件 ${plugin} 反复出错已停用，内容已保留：${describeError(error)}`
        : `插件 ${plugin} 出错，内容已回到出错前的状态：${describeError(error)}`,
    };
    pluginErrors = Object.freeze([...pluginErrors, pluginError]);
    emit("pluginError", pluginError);
    return pluginError;
  }

  const session = new EditorSession(
    schema,
    initial.doc,
    (docChanged) => {
      if (docChanged) {
        revision += 1;
        dirty = true;
        const patch = pendingPatch;
        pendingPatch = undefined;
        if (patch) {
          emit("patch", patch);
          autoSave?.add(patch);
        }
      }
      invalidate();
    },
    options.mode ?? "edit",
    () => ({ schemaVersion: meta.schemaVersion, plugins: { ...meta.plugins } }),
    (transaction) => {
      pendingPatch = documentPatchFromTransaction(transaction, revision, revision + 1);
    },
    (composing) => {
      invalidate();
      emit("compositionChanged", composing);
    },
    sessionExtensions,
    (notice: ClipboardNotice) => emit("clipboardNotice", notice),
  );

  /**
   * 三态对命令的门禁：禁用态一律拒绝，只读态只放行不改文档的命令。
   * 门禁放在 runtime 而不是每条命令里，插件命令因此自动受同一条规则约束。
   */
  function modeRejection(command: SessionCommand): CommandResult | null {
    const mode = session.currentMode;
    if (mode === "disabled") {
      return { ok: false, reason: "disabled", detail: "编辑器处于禁用态" };
    }
    if (mode === "readonly" && command.readOnly !== true) {
      return { ok: false, reason: "disabled", detail: "编辑器处于只读态" };
    }
    return null;
  }

  return {
    loadDocument(input: EditorEnvelope | NodeJSON): LoadResult {
      const migration = migrateEnvelope(input, migrations);
      if (!migration.ok) {
        return {
          ok: false,
          migrated: false,
          degraded: false,
          unknownNodes: [],
          unknownMarks: [],
          errors: migration.errors,
        };
      }
      const envelope = migration.envelope;
      const errors = validateEnvelope(envelope);
      if (errors.length > 0) {
        return {
          ok: false,
          migrated: false,
          degraded: false,
          unknownNodes: [],
          unknownMarks: [],
          errors,
        };
      }
      let degradation: { unknownNodes: string[]; unknownMarks: string[] };
      try {
        degradation = session.replaceDoc(envelope.doc);
      } catch (error) {
        return {
          ok: false,
          migrated: false,
          degraded: false,
          unknownNodes: [],
          unknownMarks: [],
          errors: [describeError(error)],
        };
      }
      meta = toMeta(envelope);
      // 记录本环境安装了哪些插件，供缺插件的环境判断需要什么才能完整编辑。
      // 只记真正启用的：被降级的插件没有注册 Schema，它的内容走的是未知节点兜底。
      // 已记录的版本不覆盖：文档自己的记录由该插件的迁移函数推进。
      for (const plugin of resolution.enabled) {
        meta.plugins[plugin.name] ??= plugin.structureVersion ?? 1;
      }
      // 装载是初始化，不是用户编辑：修订号与脏标记归零。
      revision = 0;
      dirty = false;
      invalidate();
      const degraded = degradation.unknownNodes.length > 0 || degradation.unknownMarks.length > 0;
      if (degraded) {
        emit("documentDegraded", undefined);
      }
      return {
        ok: true,
        migrated: migration.migrated,
        degraded,
        unknownNodes: degradation.unknownNodes,
        unknownMarks: degradation.unknownMarks,
      };
    },

    getDocument(): EditorEnvelope {
      // 同一事务只构造一次快照，避免保存面板、工具栏等订阅者反复序列化全文。
      // 用只读 Proxy 保持调用方隔离，同时让同一事务中的引用稳定。
      documentSnapshot ??= readOnlySnapshot({
        ...meta,
        plugins: { ...meta.plugins },
        annotations: cloneJson(meta.annotations),
        doc: session.docJSON,
      });
      return documentSnapshot;
    },

    getHTML(): string {
      return renderDocumentToHTML(session.docJSON, {
        nodes: resolution.nodes,
        marks: resolution.marks,
      });
    },

    execute(command: string, input?: unknown): CommandResult {
      if (destroyed) {
        return { ok: false, reason: "destroyed" };
      }
      if (session.composing) {
        return { ok: false, reason: "composing" };
      }
      const entry = commands.get(command);
      if (!entry) {
        return { ok: false, reason: "disabled", detail: `未注册的命令：${command}` };
      }
      const spec = entry.command;
      const rejection = modeRejection(spec);
      if (rejection) {
        return rejection;
      }
      // 核心命令不包裹：核心抛错是平台缺陷，掩盖它只会让问题更难查。
      if (entry.owner === undefined) {
        return spec.run(session, true, input);
      }
      if (breaker.isTripped(entry.owner)) {
        return { ok: false, reason: "disabled", detail: `插件 ${entry.owner} 已停用` };
      }
      const outcome = session.runProtected(() => spec.run(session, true, input));
      if (outcome.ok) {
        return outcome.value;
      }
      return {
        ok: false,
        reason: "pluginError",
        detail: recordPluginFailure(entry.owner, outcome.error),
      };
    },

    queryCommand(command: string, input?: unknown): CommandQuery {
      const entry = commands.get(command);
      if (destroyed || !entry) {
        return { enabled: false, active: false };
      }
      const spec = entry.command;
      const query = (): CommandQuery => {
        const active = spec.active(session, input);
        if (session.composing) {
          return { enabled: false, active };
        }
        if (modeRejection(spec)) {
          return { enabled: false, active };
        }
        return {
          enabled: spec.enabled?.(session, input) ?? spec.run(session, false, input).ok,
          active,
        };
      };
      if (entry.owner === undefined) {
        return query();
      }
      if (breaker.isTripped(entry.owner)) {
        return { enabled: false, active: false };
      }
      // 状态查询每次渲染都会跑，插件在这里抛错会直接掀掉整个工具栏。
      const outcome = session.runProtected(query);
      if (outcome.ok) {
        return outcome.value;
      }
      recordPluginFailure(entry.owner, outcome.error);
      return { enabled: false, active: false };
    },

    getMode(): EditorMode {
      return session.currentMode;
    },

    setMode(mode: EditorMode): void {
      if (destroyed || session.currentMode === mode) {
        return;
      }
      session.setMode(mode);
      invalidate();
    },

    getSelectionState(): SelectionSnapshot {
      return session.selectionSnapshot;
    },

    getSnapshot(): EditorSnapshot {
      if (!snapshot) {
        snapshot = {
          revision,
          stateRevision,
          dirty,
          mounted: session.mounted,
          mode: session.currentMode,
          composing: session.composing,
        };
      }
      return snapshot;
    },

    subscribe<TEvent extends EditorEventName>(
      event: TEvent,
      listener: (payload: EditorEventPayload[TEvent]) => void,
    ): () => void {
      const bucket = listeners.get(event) ?? new Set<AnyListener>();
      bucket.add(listener as AnyListener);
      listeners.set(event, bucket);
      return () => {
        bucket.delete(listener as AnyListener);
      };
    },

    getPluginErrors(): readonly PluginError[] {
      return pluginErrors;
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
      session.destroy();
      autoSave?.destroy();
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
    // 深拷贝：批注对象与 payload 都是调用方的，浅拷数组挡不住后续改写。
    annotations: cloneJson(envelope.annotations),
  };
}

/** JSON 快照应可读取、可序列化，但不能通过返回引用回写编辑器内部状态。 */
function readOnlySnapshot<TValue extends object>(value: TValue): TValue {
  const proxies = new WeakMap<object, object>();
  const wrap = <TObject extends object>(target: TObject): TObject => {
    const cached = proxies.get(target);
    if (cached) {
      return cached as TObject;
    }
    const proxy = new Proxy(target, {
      get(source, key, receiver) {
        const result = Reflect.get(source, key, receiver);
        return result !== null && typeof result === "object" ? wrap(result) : result;
      },
      // 对外保持快照语义：兼容既有调用方的赋值尝试，但不修改缓存快照。
      set: () => true,
      deleteProperty: () => true,
      defineProperty: () => true,
    });
    proxies.set(target, proxy);
    return proxy;
  };
  return wrap(value);
}
