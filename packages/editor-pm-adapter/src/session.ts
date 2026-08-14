import type { NodeJSON } from "@kaelen/editor-shared-types";
import { type MarkType, Node as ProseMirrorNode, type Schema } from "prosemirror-model";
import { type Command, EditorState, type Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
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

  constructor(
    private readonly schema: Schema,
    doc: NodeJSON,
    private readonly onChange: SessionChangeListener = () => {},
  ) {
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
  replaceDoc(doc: NodeJSON): string[] {
    const { doc: sanitized, unknownNodes } = sanitizeDoc(this.schema, doc);
    this.state = EditorState.create({
      schema: this.schema,
      doc: ProseMirrorNode.fromJSON(this.schema, sanitized),
      plugins: editorPlugins(this.schema),
    });
    this.view?.updateState(this.state);
    return unknownNodes;
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
