import {
  buildSchema,
  COLLAB_DISABLED,
  type CollabSessionOptions,
  documentPatchFromTransaction,
  EditorSession,
  type SessionCommand,
} from "@kaelen/editor-pm-adapter";
import {
  assertMigrationsDeclareReversibility,
  cloneJson,
  countText,
  createEmptyEnvelope,
  documentToMarkdown,
  migrateEnvelope,
  type RenderSchema,
  renderDocumentToHTML,
  validateEnvelope,
} from "@kaelen/editor-schema";
import type {
  Annotation,
  ClipboardNotice,
  CollabRejection,
  CollabState,
  CommandQuery,
  CommandResult,
  DocumentLimitNotice,
  DocumentMigration,
  DocumentPatch,
  DocumentTextStats,
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
  /**
   * 当前信封序列化后的 UTF-8 字节数。宿主在全量保存前据此执行 §14.2 的 2MB
   * 上限：保存是宿主的动作，编辑器只提供可判定的事实。
   */
  getDocumentSize(): number;
  /**
   * 当前文档的字数。同一次内容变更内只算一次，反复读取不重复遍历全文。
   */
  getTextStats(): DocumentTextStats;
  /** 从当前结构化文档生成 HTML；与服务端共用纯 JS renderer。 */
  getHTML(): string;
  /** 从当前结构化文档生成 Markdown。同样是纯 JS，服务端可直接调用。 */
  getMarkdown(): string;
  /**
   * 当前批注表（方案 §9.8）。装了批注类插件（如评论）时是随事务映射的活数据，
   * 否则原样透出装载时信封里的内容。只读；引用在批注未变时保持稳定，
   * 可直接喂给框架订阅。
   */
  getAnnotations(): readonly Annotation[];
  /**
   * 已启用插件贡献的节点/标记规格。
   *
   * 给的是"外部序列化器需要的那张扩展表"，与 `renderDocumentToHTML` 的第二个
   * 参数同一形状。Markdown 导入要靠它才知道 `co_table` 一类的结构长什么样，
   * 而解析器是可选依赖，不该被塞进 runtime——宿主自己把两者接起来。
   */
  getSchemaExtensions(): RenderSchema;
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
  /**
   * 协同会话状态。未配置协同时 `enabled` 为 false。
   *
   * 引用在状态未变时保持稳定，可直接喂给框架订阅；变化会触发 `change` 与
   * `collabChanged` 两个事件。
   */
  getCollabState(): CollabState;
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
  /**
   * 协同会话（方案 §17）。传入即启用，provider 由宿主注入——传输是可替换的，
   * 本仓库的 WebSocket 实现只是其中一种（见 `@kaelen/editor-collab`）。
   */
  collab?: CollabSessionOptions;
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
  // 批注权威最多一个：装了评论类插件时批注是它的活数据，否则原样透传信封。
  const annotationOwner = sessionExtensions.find(
    (extension) => typeof extension.annotations === "function",
  );
  const breaker = new PluginBreaker();

  let meta = toMeta(initial);
  let revision = 0;
  let stateRevision = 0;
  let dirty = false;
  let destroyed = false;
  let snapshot: EditorSnapshot | null = null;
  let documentSnapshot: EditorEnvelope | null = null;
  let documentProxy: EditorEnvelope | null = null;
  let documentSize: number | null = null;
  let textStats: DocumentTextStats | null = null;
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
  // 必须先于会话声明：闸门当场判定不兼容时，`rejected` 会在会话构造函数里
  // 同步回调，那时读一个还没进入作用域的 let 会直接抛。
  let collabState: CollabState = COLLAB_DISABLED;

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
    documentProxy = null;
    documentSize = null;
    textStats = null;
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
    (notice: DocumentLimitNotice) => emit("limitExceeded", notice),
    options.collab,
    (state: CollabState) => {
      collabState = state;
      // 协同状态不只是提示：连接状态、在线协作者、被拒都会改变工具栏能做什么，
      // 因此同时走通用的 change，宿主不必为它单独订阅一次。
      invalidate();
      emit("collabChanged", state);
    },
    (rejection: CollabRejection) => emit("collabRejected", rejection),
  );
  collabState = session.collabState;

  /**
   * 三态对命令的门禁：禁用态一律拒绝，只读态只放行不改文档的命令。
   * 门禁放在 runtime 而不是每条命令里，插件命令因此自动受同一条规则约束。
   */
  /** 当前批注的真实数组：有权威扩展时取活数据，否则用装载时记下的那份。 */
  function currentAnnotations(): readonly Annotation[] {
    return annotationOwner?.annotations?.() ?? meta.annotations;
  }

  // 只读包装按源数组缓存：批注没变时 getAnnotations() 必须返回同一个引用。
  const annotationProxies = new WeakMap<object, readonly Annotation[]>();
  function readOnlyAnnotations(): readonly Annotation[] {
    const source = currentAnnotations();
    let proxy = annotationProxies.get(source);
    if (!proxy) {
      proxy = readOnlySnapshot(source as Annotation[]);
      annotationProxies.set(source, proxy);
    }
    return proxy;
  }

  /** 当前信封的真实对象，同一事务内复用；`getDocument` 与大小计算共享它。 */
  function currentEnvelope(): EditorEnvelope {
    documentSnapshot ??= {
      ...meta,
      plugins: { ...meta.plugins },
      annotations: cloneJson(currentAnnotations()) as Annotation[],
      doc: session.docJSON,
    };
    return documentSnapshot;
  }

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
      if (session.collabBound) {
        // 共享文档才是事实来源。在这里装载会把本地这份内容写进 Y.Doc，
        // 也就是替所有协作者把文档换掉——比"装不上"严重得多。
        return {
          ok: false,
          migrated: false,
          degraded: false,
          unknownNodes: [],
          unknownMarks: [],
          errors: ["协同已绑定共享文档，装载本地文档会覆盖所有协作者的内容"],
        };
      }
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
      // 批注权威接手信封里的批注：装载后由它随事务映射，取回时再从它拿。
      annotationOwner?.loadAnnotations?.(envelope.annotations);
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
      documentProxy ??= readOnlySnapshot(currentEnvelope());
      return documentProxy;
    },

    /**
     * 序列化真实对象而不是 `getDocument()` 的只读 Proxy：后者会为遍历到的
     * 每个子对象再包一层代理，量到的字节数一样，代价却不一样。
     */
    getDocumentSize(): number {
      documentSize ??= utf8ByteLength(JSON.stringify(currentEnvelope()));
      return documentSize;
    },

    /**
     * 字数按需计算并缓存到下一次变更：宿主可以在每次渲染里读它，代价只发生在
     * 内容真的变了之后的第一次读取。引用同样稳定，可直接喂给框架订阅。
     */
    getTextStats(): DocumentTextStats {
      textStats ??= countText(session.textContent);
      return textStats;
    },

    getHTML(): string {
      return renderDocumentToHTML(session.docJSON, {
        nodes: resolution.nodes,
        marks: resolution.marks,
      });
    },

    getMarkdown(): string {
      return documentToMarkdown(session.docJSON, {
        nodes: resolution.nodes,
        marks: resolution.marks,
      });
    },

    getAnnotations(): readonly Annotation[] {
      return readOnlyAnnotations();
    },

    // 拷一层再交出去：插件规格是启动时定死的内部状态，宿主拿到的应该是一张
    // 只读的表，不是能往里塞节点的注册中心。
    getSchemaExtensions(): RenderSchema {
      return { nodes: { ...resolution.nodes }, marks: { ...resolution.marks } };
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

    getCollabState(): CollabState {
      return collabState;
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

/** UTF-8 字节数。上限是存储契约，按字节而不是按字符——CJK 一个字三字节。 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
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
