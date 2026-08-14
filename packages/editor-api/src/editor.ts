import { createRuntime } from "@kaelen/editor-runtime";
import type {
  CommandQuery,
  CommandResult,
  EditorEnvelope,
  EditorEventName,
  EditorSnapshot,
  LoadResult,
} from "@kaelen/editor-shared-types";

/**
 * 面向业务的编辑器接口。
 *
 * 这里刻意不出现 `EditorState`、`Transaction`、`Node`、`PluginKey` 等
 * ProseMirror 类型：业务不能派发事务、不能持有可变内部状态，接口可 mock
 * 可测试（方案 §7.1）。
 */
export interface RichEditor {
  /** 装载文档：不产生可撤销记录，用于初始化。 */
  loadDocument(envelope: EditorEnvelope): LoadResult;
  getDocument(): EditorEnvelope;

  execute(command: string): CommandResult;
  /** 工具栏所需状态：能否执行、当前是否生效。 */
  queryCommand(command: string): CommandQuery;

  /** 引用稳定的状态快照，供 useSyncExternalStore / Vue computed 使用。 */
  getSnapshot(): EditorSnapshot;
  /** 订阅状态变化。返回取消订阅函数。 */
  subscribe(event: EditorEventName, listener: () => void): () => void;
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

export function createEditor(): RichEditor {
  const runtime = createRuntime();

  return {
    loadDocument: (envelope) => runtime.loadDocument(envelope),
    getDocument: () => runtime.getDocument(),
    execute: (command) => runtime.execute(command),
    queryCommand: (command) => runtime.queryCommand(command),
    getSnapshot: () => runtime.getSnapshot(),
    subscribe: (event, listener) => runtime.subscribe(event, listener),
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
