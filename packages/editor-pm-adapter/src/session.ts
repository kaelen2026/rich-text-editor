import type { BlockAlign } from "@kaelen/editor-schema";
import {
  type CollabRejection,
  type CollabState,
  DOCUMENT_NODE_LIMIT,
  type DocumentLimitNotice,
  type EditorMode,
  type NodeJSON,
  type SelectionSnapshot,
} from "@kaelen/editor-shared-types";
import { type MarkType, Node as ProseMirrorNode, type Schema } from "prosemirror-model";
import { type Command, EditorState, Plugin, type Transaction } from "prosemirror-state";
import { Mapping } from "prosemirror-transform";
import { DecorationSet, type DirectEditorProps, EditorView } from "prosemirror-view";
import {
  hasLanguageBlock,
  isBlockAligned,
  isBlockOfType,
  isCheckedTaskItem,
  isCodeLanguageActive,
  isWithinNode,
} from "./block-commands";
import {
  type ClipboardNotice,
  type ClipboardPayloadMeta,
  createClipboardPlugin,
} from "./clipboard";
import { COLLAB_DISABLED, CollabBinding, type CollabSessionOptions } from "./collab";
import { countNodes, insertedNodeCount } from "./document-limits";
import { editorPlugins, historyCommandsFor } from "./plugins";
import { restoreDoc, sanitizeDoc } from "./unknown";

/** 状态变化通知。`docChanged` 区分内容变更与仅选区变更。 */
export type SessionChangeListener = (docChanged: boolean) => void;
/** 文档事务观察者。仅内部运行时使用，以便生成平台 patch 而不向业务泄漏 PM。 */
export type SessionTransactionListener = (transaction: Transaction) => void;

/**
 * `compositionend` 之后等下一笔事务来冲刷队列的兜底时限。
 *
 * 正常路径不会走到它——上屏文本会带来那一笔事务。它兜的是"组合结束但没产出任何
 * 文字"（用户按 Esc 撤掉候选）的情况：那时没有后续事务，位置也没动，晚一点冲刷
 * 只影响回填出现的时机。取值宽于 ProseMirror 自己的 20ms 读回定时器。
 */
const COMPOSITION_FLUSH_FALLBACK_MS = 250;

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
  /** 组合结束后队列还等着冲刷，见 `scheduleFlush`。 */
  private flushScheduled = false;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly pendingTransactions: Array<{ transaction: Transaction; mapping: Mapping }> = [];
  /** 当前文档节点数的保守上界，见 `insertedNodeCount`。 */
  private nodeCountBound = 0;
  /** 最近一次 dispatch 是否被规模上限挡下，供 `applyCommand` 如实回报给宿主。 */
  private lastDispatchRejected = false;
  private readonly collab: CollabBinding | undefined;

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
    private readonly onLimitExceeded: (notice: DocumentLimitNotice) => void = () => {},
    collab?: CollabSessionOptions,
    private readonly onCollabChange: (state: CollabState) => void = () => {},
    private readonly onCollabRejected: (rejection: CollabRejection) => void = () => {},
  ) {
    this.mode = mode;
    this.collab = collab ? new CollabBinding(collab) : undefined;
    this.state = EditorState.create({
      schema,
      doc: ProseMirrorNode.fromJSON(schema, sanitizeDoc(schema, doc).doc),
      plugins: this.buildPlugins(),
    });
    this.nodeCountBound = countNodes(this.state.doc);
    for (const extension of this.extensions) {
      extension.bind?.({
        schema: this.schema,
        getState: () => this.state,
        dispatch: (transaction) => this.dispatch(transaction),
      });
    }
    // 绑定要在状态建好之后再接：闸门一旦当场放行就会回调 reconfigure。
    this.collab?.attach(this.schema, {
      reconfigure: () => this.reconfigurePlugins(),
      changed: () => this.onCollabChange(this.collabState),
      rejected: (rejection) => this.onCollabRejected(rejection),
    });
  }

  /**
   * 插件表。三处装配（构造、装载新文档、协同绑定变化）共用同一份，
   * 少了它，"协同下不装 prosemirror-history"这类规则很容易只在其中一处成立。
   */
  private buildPlugins(): Plugin[] {
    return [
      ...editorPlugins(this.schema, () => this.isComposing, this.collab?.bound === true),
      // 协同的远端光标同样是覆盖文本的 Decoration，必须一起走冻结包装：
      // 组合期间重算它会让 ProseMirror 重建那段 DOM，候选文本随即消失。
      ...(this.collab?.plugins() ?? []).map((plugin) => this.freezeComposingDecorations(plugin)),
      ...this.extensionPlugins(),
      createClipboardPlugin({
        getPayloadMeta: this.clipboardMeta,
        onNotice: this.onClipboardNotice,
      }),
    ];
  }

  /**
   * 装上或卸下协同插件。用 `reconfigure` 而不是重建状态：文档、选区和本地
   * 历史都留着，用户不会因为连上协作而丢掉正在编辑的位置。
   */
  private reconfigurePlugins(): void {
    this.state = this.state.reconfigure({ plugins: this.buildPlugins() });
    this.view?.updateState(this.state);
    this.onChange(false);
  }

  private extensionPlugins(): readonly Plugin[] {
    return this.extensions
      .flatMap((extension) => extension.plugins(this.schema))
      .map((plugin) => this.freezeComposingDecorations(plugin));
  }

  get collabState(): CollabState {
    return this.collab?.state ?? COLLAB_DISABLED;
  }

  /** 协同已绑定共享文档：此时装载本地文档会覆盖所有协作者的内容。 */
  get collabBound(): boolean {
    return this.collab?.bound === true;
  }

  /**
   * 撤销/重做。实现随协同状态切换：单机走 `prosemirror-history`，协同下走
   * `Y.UndoManager`——后者只回退自己的改动，前者会把别人的一起退掉。
   */
  applyHistoryCommand(kind: "undo" | "redo", apply: boolean): boolean {
    return this.applyCommand(historyCommandsFor(this.collabBound)[kind], apply);
  }

  /**
   * 组合态期间冻结覆盖当前文本节点的 Decoration（方案 §9.6 第 3 条）。
   *
   * 组合中的那段文本此刻由浏览器和输入法接管，DOM 与模型短暂不同步。这时候
   * 重算一个盖在它上面的 Decoration，ProseMirror 就会去重建那段 DOM——候选文本
   * 被抹掉、组合被打断，用户看到的是打一半的字突然消失。
   *
   * 只冻当前文本块这一段，不是整张 Decoration 表：别处的上传进度条照常动，
   * 冻结的代价不该扩散到与组合无关的地方。范围之外用新算出来的，范围之内沿用
   * 上一次的结果——组合期间会改文档的事务都在 `dispatch` 里排了队，位置不会动，
   * 因此旧 Decoration 直接复用是安全的，不需要重新映射。
   */
  private freezeComposingDecorations(plugin: Plugin): Plugin {
    const decorations = plugin.spec.props?.decorations;
    if (!decorations) {
      return plugin;
    }
    const session = this;
    let previous: DecorationSet | undefined;
    return new Plugin({
      ...plugin.spec,
      props: {
        ...plugin.spec.props,
        decorations(this: Plugin, state: EditorState) {
          const raw = decorations.call(this, state);
          // 插件也可以返回别的 `DecorationSource`（例如另一棵视图的 decoration 树）。
          // 那种形态不支持按范围增删，冻结无从下手，原样放行而不是丢掉。
          if (!(raw instanceof DecorationSet)) {
            return raw;
          }
          if (!session.isComposing || !previous) {
            previous = raw;
            return raw;
          }
          const { from, to } = composingTextblockRange(state);
          if (from === to) {
            return raw;
          }
          // 范围内换回旧的：先把新算出来的那部分摘掉，再把旧的贴回去。
          const outside = raw.remove(raw.find(from, to));
          return outside.add(state.doc, previous.find(from, to));
        },
      },
    });
  }

  get docJSON(): NodeJSON {
    return restoreDoc(this.state.doc.toJSON() as NodeJSON);
  }

  /**
   * 全文纯文本，块之间不补分隔符、叶节点不产生文本——字数是内容的量，
   * 不是排版的量。取自活文档，因此数字数不必先把整棵树序列化成 JSON。
   */
  get textContent(): string {
    return this.state.doc.textBetween(0, this.state.doc.content.size, "", "");
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
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.flushScheduled = false;
    this.pendingTransactions.length = 0;
    this.isComposing = false;
    this.collab?.destroy();
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
      plugins: this.buildPlugins(),
    });
    this.view?.updateState(this.state);
    // 装载不受节点上限约束：已经超限的历史文档必须打得开，随后的插入才受限。
    this.nodeCountBound = countNodes(this.state.doc);
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
    this.lastDispatchRejected = false;
    const ran = command(this.state, (transaction) => this.dispatch(transaction));
    // 命令自认为成功，但事务被规模上限挡下了：对宿主而言这条命令没有生效。
    return ran && !this.lastDispatchRejected;
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

  /** 选区内是否有可指定语言的代码块。 */
  hasCodeLanguage(): boolean {
    return hasLanguageBlock(this.state);
  }

  /** 选区内的代码块是否都是该语言。 */
  isCodeLanguage(language: string | null): boolean {
    return isCodeLanguageActive(this.state, language);
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
    const next = this.state.apply(transaction);
    if (this.exceedsNodeLimit(transaction, next)) {
      // 事务整体丢弃。视图的 DOM 可能已被用户输入改过，用旧状态刷一次让它回到模型。
      this.view?.updateState(this.state);
      return;
    }
    for (const pending of this.pendingTransactions) {
      pending.mapping.appendMapping(transaction.mapping);
    }
    this.state = next;
    this.view?.updateState(this.state);
    if (transaction.docChanged) {
      this.onDocumentTransaction(transaction);
    }
    this.onChange(transaction.docChanged);
    // 上屏文本本身就是"下一笔事务"。它到了，模型就追上 DOM 了，此刻冲刷队列
    // 才安全，且它的 mapping 已经在上面并进了每一笔待冲刷事务。
    //
    // 但要等这一笔走完再冲：此刻我们正站在 ProseMirror 读回 DOM 的调用栈里，
    // 在那当中再派发一笔事务，读回的后半段会按它自己那份旧假设继续跑，刚插进去
    // 的内容随即被抹掉。微任务足够——它在当前同步栈清空之后、下一次渲染之前。
    if (this.flushScheduled && !this.isComposing) {
      this.claimScheduledFlush();
      queueMicrotask(() => this.flushPendingTransactions());
    }
  }

  /**
   * 节点数硬上限（方案 §14.2）。放在事务入口而不是各个插入命令里：打字、粘贴、
   * 拖入、插件回填走的是同一条路，规则也就只需要一份。
   *
   * 常态下不做全文遍历——先用只增的保守上界判断，只有上界触到硬上限时才精确
   * 重算一次并把上界收回真实值。删除因此不必立刻反映到上界上，代价只是在
   * 反复增删的文档里偶尔多算一次。
   */
  private exceedsNodeLimit(transaction: Transaction, next: EditorState): boolean {
    if (!transaction.docChanged) {
      return false;
    }
    const inserted = insertedNodeCount(transaction);
    if (inserted === 0) {
      return false;
    }
    const bound = this.nodeCountBound + inserted;
    if (bound <= DOCUMENT_NODE_LIMIT) {
      this.nodeCountBound = bound;
      return false;
    }
    const exact = countNodes(next.doc);
    this.nodeCountBound = exact;
    if (exact <= DOCUMENT_NODE_LIMIT) {
      return false;
    }
    // 上界被拒绝的事务撑大了没有意义：文档仍停在被拒绝之前。
    this.nodeCountBound = countNodes(this.state.doc);
    this.lastDispatchRejected = true;
    this.onLimitExceeded({
      code: "document-node-limit",
      limit: DOCUMENT_NODE_LIMIT,
      actual: exact,
      message: `文档节点数不能超过 ${DOCUMENT_NODE_LIMIT}，本次插入已取消`,
    });
    return true;
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
    this.collab?.setComposing(composing);
    this.onCompositionChange(composing);
    if (!composing) {
      this.scheduleFlush();
    }
  }

  /**
   * `compositionend` 之后不能立刻冲刷队列。
   *
   * ProseMirror 要等它自己的 DOM 观察器把上屏文本从 DOM 读回模型，那发生在事件
   * **之后**。在那之前把队列应用进去，紧接着的读回会按 DOM 重写整个文本块——刚
   * 落地的回填连同它的位置一起被抹掉。这条是真实浏览器用例发现的：jsdom 里没有
   * 读回这一步，同步冲刷看上去一直是对的。
   *
   * 因此等下一笔事务再冲刷：上屏文本本身就是那一笔，而它的 mapping 正是回填需要
   * 的位移。一直没有下一笔（组合没产出任何文字）时由超时兜底，那种情况下位置本来
   * 也没动。
   */
  private scheduleFlush(): void {
    if (this.pendingTransactions.length === 0 || this.flushScheduled) {
      return;
    }
    this.flushScheduled = true;
    this.flushTimer = setTimeout(() => {
      if (this.claimScheduledFlush()) {
        this.flushPendingTransactions();
      }
    }, COMPOSITION_FLUSH_FALLBACK_MS);
  }

  /** 取消兜底计时器并把"待冲刷"标志落掉。冲刷本身会走 applyTransaction，不落标志就会递归。 */
  private claimScheduledFlush(): boolean {
    if (!this.flushScheduled) {
      return false;
    }
    this.flushScheduled = false;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    return true;
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

/**
 * 正在被输入法接管的那段文本的范围：光标所在文本块的内容区间。
 *
 * 取整个文本块而不是光标处的单个文本节点：ProseMirror 会按标记把文本切成多个
 * 节点，而组合可能横跨其中几个；只冻一个节点，相邻那段照样会被重建。
 */
function composingTextblockRange(state: EditorState): { from: number; to: number } {
  const $from = state.selection.$from;
  if (!$from.parent.isTextblock) {
    return { from: 0, to: 0 };
  }
  return { from: $from.start(), to: $from.end() };
}
