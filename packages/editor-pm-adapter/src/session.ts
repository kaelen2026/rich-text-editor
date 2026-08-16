import type { BlockAlign } from "@kaelen/editor-schema";
import type { EditorMode, NodeJSON, SelectionSnapshot } from "@kaelen/editor-shared-types";
import { type MarkType, Node as ProseMirrorNode, type Schema } from "prosemirror-model";
import { type Command, EditorState, type Plugin, type Transaction } from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import { type DirectEditorProps, EditorView } from "prosemirror-view";
import { isBlockAligned, isBlockOfType, isCheckedTaskItem, isWithinNode } from "./block-commands";
import {
  type ClipboardNotice,
  type ClipboardPayloadMeta,
  createClipboardPlugin,
} from "./clipboard";
import { editorPlugins } from "./plugins";
import { restoreDoc, sanitizeDoc } from "./unknown";

/** 状态变化通知。`docChanged` 区分内容变更与仅选区变更。 */
export type SessionChangeListener = (docChanged: boolean) => void;
/** 文档事务观察者。仅内部运行时使用，以便生成平台 patch 而不向业务泄漏 PM。 */
export type SessionTransactionListener = (transaction: Transaction) => void;

/** 受保护调用的结果。失败时状态已回滚，`error` 原样交给调用方上报。 */
export type ProtectedOutcome<TValue> = { ok: true; value: TValue } | { ok: false; error: unknown };

/** 文档中的选区位置。位置语义与 `DocumentPatch` 一致：文档扁平偏移量。 */
export interface SelectionRange {
  anchor: number;
  head: number;
}

/**
 * 可选能力向会话注册的 ProseMirror 插件。这个窄桥只在 PM 适配层和能力插件之间
 * 流动，业务 API 与 runtime 的公共编辑器接口仍不暴露 ProseMirror 状态。
 */
export interface SessionExtension {
  plugins(schema: Schema): readonly Plugin[];
  bind?(bridge: SessionBridge): void;
  unmount?(): void;
  destroy?(): void;
}

/** 能力插件需要的最小会话能力，异步结果可通过它安全回到唯一事务入口。 */
export interface SessionBridge {
  readonly schema: Schema;
  getState(): EditorState;
  dispatch(transaction: Transaction): void;
}

/**
 * 拥有 ProseMirror 状态的会话。ProseMirror 类型不越过这个边界向上层泄漏，
 * 上层只看到 `NodeJSON` 等平台自有类型（方案 §7.1）。
 */
export class EditorSession {
  private state: EditorState;
  private view: EditorView | null = null;
  private mode: EditorMode;
  private isComposing = false;
  private compositionTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingTransactions: Array<{ transaction: Transaction; mapping: Mapping }> = [];

  constructor(
    private readonly schema: Schema,
    doc: NodeJSON,
    private readonly onChange: SessionChangeListener = () => {},
    mode: EditorMode = "edit",
    private readonly clipboardMeta: () => ClipboardPayloadMeta = () => ({
      schemaVersion: 1,
      plugins: {},
    }),
    private readonly onDocumentTransaction: SessionTransactionListener = () => {},
    private readonly onCompositionChange: (composing: boolean) => void = () => {},
    private readonly extensions: readonly SessionExtension[] = [],
    private readonly onClipboardNotice: (notice: ClipboardNotice) => void = () => {},
  ) {
    this.mode = mode;
    this.state = EditorState.create({
      schema,
      doc: ProseMirrorNode.fromJSON(schema, sanitizeDoc(schema, doc).doc),
      plugins: [
        ...editorPlugins(schema, () => this.isComposing),
        ...this.extensionPlugins(),
        createClipboardPlugin({ getPayloadMeta: clipboardMeta, onNotice: onClipboardNotice }),
      ],
    });
    for (const extension of this.extensions) {
      extension.bind?.({
        schema: this.schema,
        getState: () => this.state,
        dispatch: (transaction) => this.dispatch(transaction),
      });
    }
  }

  private extensionPlugins(): readonly Plugin[] {
    return this.extensions.flatMap((extension) => extension.plugins(this.schema));
  }

  get docJSON(): NodeJSON {
    return restoreDoc(this.state.doc.toJSON() as NodeJSON);
  }

  get mounted(): boolean {
    return this.view !== null;
  }

  get currentMode(): EditorMode {
    return this.mode;
  }

  /** 组合期间模型只接收用户输入，业务命令和异步事务必须等待。 */
  get composing(): boolean {
    return this.isComposing;
  }

  /** 切换三态。视图已挂载时就地改属性，不重建，选区与历史都保住。 */
  setMode(mode: EditorMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.view?.setProps(this.modeProps());
  }

  /**
   * 三态的 DOM 表达。只读态补 `tabindex="0"`：`contenteditable="false"` 的
   * 元素默认不进 Tab 序，而只读要求可聚焦、可选中、可复制；禁用态刻意不补，
   * 于是它自然落在 Tab 序之外（方案 §4.1、§15）。
   */
  private modeProps(): Partial<DirectEditorProps> {
    return {
      editable: () => this.mode === "edit",
      attributes: () => {
        const attributes: Record<string, string> = {
          "data-mode": this.mode,
          role: "textbox",
          "aria-multiline": "true",
        };
        if (this.mode === "readonly") {
          attributes.tabindex = "0";
          attributes["aria-readonly"] = "true";
        }
        if (this.mode === "disabled") {
          attributes["aria-disabled"] = "true";
        }
        return attributes;
      },
    };
  }

  get selection(): SelectionRange {
    const { anchor, head } = this.state.selection;
    return { anchor, head };
  }

  get selectionSnapshot(): SelectionSnapshot {
    const { $from, empty } = this.state.selection;
    const { storedMarks } = this.state;
    const marks = storedMarks ?? $from.marks();
    const path: string[] = [];
    for (let depth = 0; depth <= $from.depth; depth += 1) {
      path.push($from.node(depth).type.name);
    }
    return {
      empty,
      marks: marks.map((mark) => mark.type.name),
      blockType: $from.parent.type.name,
      path,
      composing: this.isComposing,
    };
  }

  /**
   * 在可回滚检查点上运行一段可能抛错的代码（插件命令、NodeView、剪贴板规则）。
   *
   * 抛错时状态整体回到调用前——因为 `EditorState` 是不可变值，检查点就是当前状态
   * 本身，回滚是 O(1) 且连选区与撤销历史一起复原，比"用最后一次已知良好文档重建
   * EditorView"（方案 §8.6）更完整：那种重建会清空历史，选区也只能尽力而为。
   * 需要真正重建视图的场景（NodeView 让 DOM 与模型失同步）随 NodeView 切片再补。
   */
  runProtected<TValue>(run: () => TValue): ProtectedOutcome<TValue> {
    const checkpoint = this.state;
    try {
      return { ok: true, value: run() };
    } catch (error) {
      if (this.state === checkpoint) {
        return { ok: false, error };
      }
      const docChanged = this.state.doc !== checkpoint.doc;
      this.state = checkpoint;
      this.view?.updateState(checkpoint);
      // 插件的事务已经通知过一次，回滚必须再通知一次，否则 UI 停在被回滚的内容上。
      this.onChange(docChanged);
      return { ok: false, error };
    }
  }

  /**
   * 视图生命周期，与实例生命周期正交且幂等：重复 mount 不产生第二个视图，
   * 重复 unmount 不抛异常。React 18 StrictMode 会 mount → unmount → mount，
   * 不幂等在开发模式下直接不可用（方案 §8.2）。
   */
  mount(element: HTMLElement): void {
    if (this.view) {
      return;
    }
    this.view = new EditorView(element, {
      state: this.state,
      dispatchTransaction: (transaction) => this.applyTransaction(transaction),
      handleDOMEvents: {
        compositionstart: () => {
          this.setComposing(true);
          return false;
        },
        compositionend: () => {
          this.setComposing(false);
          return false;
        },
      },
      ...this.modeProps(),
    });
  }

  unmount(): void {
    this.view?.destroy();
    this.view = null;
    for (const extension of this.extensions) {
      extension.unmount?.();
    }
  }

  /** 实例销毁时取消兜底计时器，避免已销毁 runtime 仍收到组合态通知。 */
  destroy(): void {
    this.unmount();
    if (this.compositionTimer !== undefined) {
      clearTimeout(this.compositionTimer);
      this.compositionTimer = undefined;
    }
    this.pendingTransactions.length = 0;
    this.isComposing = false;
    for (const extension of this.extensions) {
      extension.destroy?.();
    }
  }

  focus(): void {
    this.view?.focus();
  }

  /**
   * 装载新文档。重建状态因此历史被清空——"装载不产生可撤销记录"由此成立，
   * 用户无法撤销到装载之前（方案 §8.1）。
   */
  replaceDoc(doc: NodeJSON): { unknownNodes: string[]; unknownMarks: string[] } {
    const { doc: sanitized, unknownNodes, unknownMarks } = sanitizeDoc(this.schema, doc);
    this.state = EditorState.create({
      schema: this.schema,
      doc: ProseMirrorNode.fromJSON(this.schema, sanitized),
      plugins: [
        ...editorPlugins(this.schema, () => this.isComposing),
        ...this.extensionPlugins(),
        createClipboardPlugin({
          getPayloadMeta: this.clipboardMeta,
          onNotice: this.onClipboardNotice,
        }),
      ],
    });
    this.view?.updateState(this.state);
    return { unknownNodes, unknownMarks };
  }

  /**
   * 运行一个命令。`apply` 为 false 时只做可行性判断，不改状态——
   * 这是 `queryCommand().enabled` 的实现方式。
   */
  applyCommand(command: Command, apply: boolean): boolean {
    if (!apply) {
      return command(this.state);
    }
    return command(this.state, (transaction) => this.dispatch(transaction));
  }

  /**
   * 需要 Schema 才能构造的命令走这里。命令工厂拿不到状态与视图，
   * ProseMirror 类型因此仍然止于本包（方案 §7.1）。
   */
  applySchemaCommand(build: (schema: Schema) => Command, apply: boolean): boolean {
    return this.applyCommand(build(this.schema), apply);
  }

  /** 选区覆盖的文本块是否都是该类型（并且属性一致）。 */
  isBlockActive(nodeName: string, attrs?: Record<string, unknown>): boolean {
    return isBlockOfType(this.state, nodeName, attrs);
  }

  /** 选区内可对齐的文本块是否都是该对齐。 */
  isAligned(align: BlockAlign | null): boolean {
    return isBlockAligned(this.state, align);
  }

  /** 选区是否位于某个结构容器（引用、列表）之内。 */
  isWithin(nodeName: string): boolean {
    return isWithinNode(this.state, nodeName);
  }

  isTaskChecked(): boolean {
    return isCheckedTaskItem(this.state);
  }

  /** 能力插件的异步回填也必须汇聚到本入口，才能遵守组合态和事件契约。 */
  dispatch(transaction: Transaction): void {
    if (this.isComposing && transaction.docChanged) {
      this.pendingTransactions.push({ transaction, mapping: new Mapping() });
      return;
    }
    if (this.view) {
      // 走视图的 dispatchTransaction，最终仍汇聚到 applyTransaction。
      this.view.dispatch(transaction);
      return;
    }
    this.applyTransaction(transaction);
  }

  /** 唯一的状态推进入口：无论来自用户输入还是命令，都在这里汇聚并通知。 */
  private applyTransaction(transaction: Transaction): void {
    for (const pending of this.pendingTransactions) {
      pending.mapping.appendMapping(transaction.mapping);
    }
    this.state = this.state.apply(transaction);
    this.view?.updateState(this.state);
    if (transaction.docChanged) {
      this.onDocumentTransaction(transaction);
    }
    this.onChange(transaction.docChanged);
  }

  /** DOM composition 事件与超时兜底都汇到这里，避免重复冲刷队列。 */
  private setComposing(composing: boolean): void {
    if (this.isComposing === composing) {
      return;
    }
    this.isComposing = composing;
    if (composing) {
      this.compositionTimer = setTimeout(() => this.setComposing(false), 5_000);
    } else {
      if (this.compositionTimer !== undefined) {
        clearTimeout(this.compositionTimer);
        this.compositionTimer = undefined;
      }
    }
    this.onCompositionChange(composing);
    if (!composing) {
      this.flushPendingTransactions();
    }
  }

  /**
   * 延迟事务的 step 以其排队后的用户输入 Mapping 重放；每冲刷一笔，再把它的
   * Mapping 加进后续事务，因而同一组合态内的多笔异步事务也保持原有顺序。
   */
  private flushPendingTransactions(): void {
    while (this.pendingTransactions.length > 0) {
      const pending = this.pendingTransactions.shift();
      if (!pending) {
        return;
      }
      const transaction = this.state.tr;
      for (const step of pending.transaction.steps) {
        const mapped = step.map(pending.mapping);
        if (mapped) {
          transaction.step(mapped);
        }
      }
      if (pending.transaction.getMeta("addToHistory") === false) {
        transaction.setMeta("addToHistory", false);
      }
      if (transaction.docChanged || transaction.selectionSet) {
        this.applyTransaction(transaction);
      }
    }
  }

  /**
   * 标记是否覆盖整个选区。用"整体覆盖"而非"部分命中"作为生效态语义，
   * 与 `toggleMark({removeWhenPresent:false})` 的行为一致：部分加粗时
   * 按一次加粗是补齐而不是取消。
   */
  isMarkActive(markName: string): boolean {
    const markType = this.schema.marks[markName];
    if (!markType) {
      return false;
    }
    const { selection, storedMarks, doc } = this.state;
    if (selection.empty) {
      return markType.isInSet(storedMarks ?? selection.$from.marks()) !== undefined;
    }
    let sawText = false;
    let covered = true;
    for (const range of selection.ranges) {
      doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
        if (!node.isText) {
          return true;
        }
        sawText = true;
        if (!markType.isInSet(node.marks)) {
          covered = false;
        }
        return false;
      });
    }
    return sawText && covered;
  }

  /**
   * 选区内是否**存在**该标记（不要求整体覆盖），且选区非空。
   * 与 `isMarkActive` 的"整体覆盖"语义不同：移除类命令需要的是"有没有可移除的"。
   */
  hasMarkInSelection(markName: string): boolean {
    const markType = this.schema.marks[markName];
    if (!markType) {
      return false;
    }
    const { selection, doc } = this.state;
    if (selection.empty) {
      return false;
    }
    let found = false;
    for (const range of selection.ranges) {
      doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
        if (found) {
          return false;
        }
        if (node.isText && markType.isInSet(node.marks)) {
          found = true;
          return false;
        }
        return true;
      });
    }
    return found;
  }

  /**
   * 在选区上覆盖某个标记：先清后加。
   *
   * 不用 `toggleMark`——选区已被完全覆盖时它会走移除分支，"改属性"就变成了
   * "删标记"。插件因此也不需要直接依赖 ProseMirror 命令（方案 §7.1）。
   */
  setMarkOverSelection(markName: string, attrs: Record<string, unknown>, apply: boolean): boolean {
    const markType = this.schema.marks[markName];
    const { selection } = this.state;
    if (!markType || selection.empty) {
      return false;
    }
    if (!apply) {
      return true;
    }
    const transaction = this.state.tr;
    for (const range of selection.ranges) {
      transaction.removeMark(range.$from.pos, range.$to.pos, markType);
      transaction.addMark(range.$from.pos, range.$to.pos, markType.create(attrs));
    }
    this.dispatch(transaction);
    return true;
  }

  removeMarkOverSelection(markName: string, apply: boolean): boolean {
    const markType = this.schema.marks[markName];
    const { selection } = this.state;
    if (!markType || selection.empty) {
      return false;
    }
    if (!apply) {
      return true;
    }
    const transaction = this.state.tr;
    for (const range of selection.ranges) {
      transaction.removeMark(range.$from.pos, range.$to.pos, markType);
    }
    this.dispatch(transaction);
    return true;
  }

  markType(markName: string): MarkType | undefined {
    return this.schema.marks[markName];
  }

  /** 返回光标或选区起点处的标记属性，供需要读取持久化属性的命令使用。 */
  markAttrsAtSelection(markName: string): Record<string, unknown> | undefined {
    const markType = this.markType(markName);
    if (!markType) {
      return undefined;
    }
    const { selection, doc, storedMarks } = this.state;
    const cursorMark = markType.isInSet(storedMarks ?? selection.$from.marks());
    if (cursorMark) {
      return cursorMark.attrs;
    }
    for (const range of selection.ranges) {
      let selectedMark: Record<string, unknown> | undefined;
      doc.nodesBetween(range.$from.pos, range.$to.pos, (node) => {
        const mark = markType.isInSet(node.marks);
        if (mark) {
          selectedMark = mark.attrs;
          return false;
        }
        return true;
      });
      if (selectedMark) {
        return selectedMark;
      }
    }
    return undefined;
  }
}
