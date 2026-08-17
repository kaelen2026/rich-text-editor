import { createRuntime, type RuntimeOptions } from "@kaelen/editor-runtime";
import type {
  CommandQuery,
  CommandResult,
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

/**
 * 面向业务的编辑器接口。
 *
 * 这里刻意不出现 `EditorState`、`Transaction`、`Node`、`PluginKey` 等
 * ProseMirror 类型：业务不能派发事务、不能持有可变内部状态，接口可 mock
 * 可测试（方案 §7.1）。
 */
export interface RichEditor {
  /**
   * 装载文档：不产生可撤销记录，用于初始化。
   * 也接受没有信封的裸文档节点（历史数据、手写 JSON），会自动迁移。
   */
  loadDocument(input: EditorEnvelope | NodeJSON): LoadResult;
  getDocument(): EditorEnvelope;
  /**
   * 当前信封序列化后的 UTF-8 字节数。全量保存前必须据此执行 `DOCUMENT_JSON_LIMIT_BYTES`
   * 上限（方案 §14.2）——保存是宿主的动作，编辑器只提供可判定的事实。
   */
  getDocumentSize(): number;
  /**
   * 当前文档字数（方案 §4.4）。按 Unicode 字符计、CJK 按字，另有不含空白的口径；
   * 同一次内容变更内只算一次，引用稳定，可直接用于框架订阅。
   */
  getTextStats(): DocumentTextStats;
  /** 从当前结构化文档渲染 HTML；可在 Node 服务端直接调用。 */
  getHTML(): string;

  execute(command: string, input?: unknown): CommandResult;
  /**
   * 工具栏所需状态：能否执行、当前是否生效。
   * 带参数的命令（如标题层级）要把同一份参数传进来，否则问的不是同一件事。
   */
  queryCommand(command: string, input?: unknown): CommandQuery;

  /** 编辑态 / 只读态 / 禁用态。三者语义不同，见 `EditorMode`（方案 §4.1）。 */
  getMode(): EditorMode;
  setMode(mode: EditorMode): void;
  getSelectionState(): SelectionSnapshot;

  /** 引用稳定的状态快照，供 useSyncExternalStore / Vue computed 使用。 */
  getSnapshot(): EditorSnapshot;
  /** 订阅状态变化。返回取消订阅函数。 */
  subscribe<TEvent extends EditorEventName>(
    event: TEvent,
    listener: (payload: EditorEventPayload[TEvent]) => void,
  ): () => void;
  /**
   * 已发生的插件降级记录，用于展示"X 功能暂时不可用，内容已保留"。
   * 包含启动期冲突：那些发生在宿主能订阅 `pluginError` 之前（方案 §8.3、§8.6）。
   */
  getPluginErrors(): readonly PluginError[];
  isDirty(): boolean;
  /** 宿主完成持久化后调用，清除脏标记且不影响撤销历史。 */
  markSaved(): void;
  getRevision(): number;

  undo(): CommandResult;
  redo(): CommandResult;

  /** 视图生命周期，由框架适配层调用。幂等，可重复配对。 */
  mount(element: HTMLElement): void;
  unmount(): void;
  /** 实例生命周期，由创建者调用。 */
  destroy(): void;
  focus(): void;
}

export type EditorOptions = RuntimeOptions;

export function createEditor(options: EditorOptions = {}): RichEditor {
  const runtime = createRuntime(options);

  return {
    loadDocument: (input) => runtime.loadDocument(input),
    getDocument: () => runtime.getDocument(),
    getDocumentSize: () => runtime.getDocumentSize(),
    getTextStats: () => runtime.getTextStats(),
    getHTML: () => runtime.getHTML(),
    execute: (command, input) => runtime.execute(command, input),
    queryCommand: (command, input) => runtime.queryCommand(command, input),
    getMode: () => runtime.getMode(),
    setMode: (mode) => runtime.setMode(mode),
    getSelectionState: () => runtime.getSelectionState(),
    getSnapshot: () => runtime.getSnapshot(),
    subscribe: (event, listener) => runtime.subscribe(event, listener),
    getPluginErrors: () => runtime.getPluginErrors(),
    isDirty: () => runtime.isDirty(),
    markSaved: () => runtime.markSaved(),
    getRevision: () => runtime.getRevision(),
    undo: () => runtime.undo(),
    redo: () => runtime.redo(),
    mount: (element) => runtime.mount(element),
    unmount: () => runtime.unmount(),
    destroy: () => runtime.destroy(),
    focus: () => runtime.focus(),
  };
}
