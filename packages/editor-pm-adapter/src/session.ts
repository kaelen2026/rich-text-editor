import type { EditorMode, NodeJSON } from "@kaelen/editor-shared-types";
import { type MarkType, Node as ProseMirrorNode, type Schema } from "prosemirror-model";
import { type Command, EditorState, type Transaction } from "prosemirror-state";
import { type DirectEditorProps, EditorView } from "prosemirror-view";
import { isBlockOfType, isCheckedTaskItem, isWithinNode } from "./block-commands";
import { editorPlugins } from "./plugins";
import { restoreDoc, sanitizeDoc } from "./unknown";

/** 状态变化通知。`docChanged` 区分内容变更与仅选区变更。 */
export type SessionChangeListener = (docChanged: boolean) => void;

/**
 * 拥有 ProseMirror 状态的会话。ProseMirror 类型不越过这个边界向上层泄漏，
 * 上层只看到 `NodeJSON` 等平台自有类型（方案 §7.1）。
 */
export class EditorSession {
  private state: EditorState;
  private view: EditorView | null = null;
  private mode: EditorMode;

  constructor(
    private readonly schema: Schema,
    doc: NodeJSON,
    private readonly onChange: SessionChangeListener = () => {},
    mode: EditorMode = "edit",
  ) {
    this.mode = mode;
    this.state = EditorState.create({
      schema,
      doc: ProseMirrorNode.fromJSON(schema, sanitizeDoc(schema, doc).doc),
      plugins: editorPlugins(schema),
    });
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
        const attributes: Record<string, string> = { "data-mode": this.mode };
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
      ...this.modeProps(),
    });
  }

  unmount(): void {
    this.view?.destroy();
    this.view = null;
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
      plugins: editorPlugins(this.schema),
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

  /** 选区是否位于某个结构容器（引用、列表）之内。 */
  isWithin(nodeName: string): boolean {
    return isWithinNode(this.state, nodeName);
  }

  isTaskChecked(): boolean {
    return isCheckedTaskItem(this.state);
  }

  private dispatch(transaction: Transaction): void {
    if (this.view) {
      // 走视图的 dispatchTransaction，最终仍汇聚到 applyTransaction。
      this.view.dispatch(transaction);
      return;
    }
    this.applyTransaction(transaction);
  }

  /** 唯一的状态推进入口：无论来自用户输入还是命令，都在这里汇聚并通知。 */
  private applyTransaction(transaction: Transaction): void {
    this.state = this.state.apply(transaction);
    this.view?.updateState(this.state);
    this.onChange(transaction.docChanged);
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
