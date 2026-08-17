import {
  type CollabAnnotationStore,
  collabAnnotationStore,
  isCollabChangeOrigin,
  type SessionBridge,
  type SessionExtension,
} from "@kaelen/editor-pm-adapter";
import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import { cloneJson } from "@kaelen/editor-schema";
import type { Annotation } from "@kaelen/editor-shared-types";
import { type EditorState, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import type { Mapping } from "prosemirror-transform";
import { Decoration, DecorationSet } from "prosemirror-view";

export interface CommentState {
  annotations: readonly Annotation[];
}

type CommentMeta =
  | { kind: "add"; annotation: Annotation }
  | { kind: "remove"; id: string }
  | { kind: "seed"; annotations: readonly Annotation[] }
  /** 协同：共享批注表变了（本端写入或远端更新），从它重投影。 */
  | { kind: "refresh" };

export const commentKey = new PluginKey<CommentState>("comment");

const EMPTY: readonly Annotation[] = Object.freeze([]);

/**
 * 可选评论能力，消费 §9.8 冻结的锚点模型：评论**不做 mark**，是文档外部的
 * 锚点表，存在信封的 `annotations` 里。mark 会随文本分裂合并产生 ID 去重问题，
 * 删除评论会留下残留 mark，还会污染复制粘贴与导出——锚点表没有这些问题，
 * 代价是位置要自己维护：每一笔事务用 `tr.mapping` 迁移，与 §9.5 的图片上传、
 * AI 回填是同一套机制。
 *
 * 本插件**不贡献任何节点或标记**——评论是元数据不是正文。因此它也没有
 * `structureVersion`；协同下它的数据走共享文档里的批注表而不是 XmlFragment，
 * 准入闸门（只认节点名与标记名）对它天然放行：没装评论插件的协作者收到评论
 * 更新时原样保存、只是看不见，而不是像未知节点那样被删掉。
 */
export function createCommentPlugin(): EditorPlugin {
  const controller = new CommentController();
  return {
    name: "comment",
    version: "1.0.0",
    namespace: "co_",
    registerCommands: (commands) => {
      commands.add("comment.add", controller.addCommand);
      commands.add("comment.remove", controller.removeCommand);
    },
    createSessionExtensions: () => [controller],
  };
}

class CommentController implements SessionExtension {
  private bridge: SessionBridge | undefined;
  /** 协同批注表。绑定共享文档后由插件视图挂上，之后它就是批注的权威。 */
  private store: CollabAnnotationStore | undefined;
  private unobserve: (() => void) | undefined;
  private refreshScheduled = false;

  plugins(): readonly Plugin[] {
    return [
      new Plugin<CommentState>({
        key: commentKey,
        state: {
          init: () => ({ annotations: [] }),
          apply: (transaction, value) => this.applyMeta(transaction, value),
        },
        props: {
          decorations: (state) => decorations(state),
        },
        // 协同批注表的接线放在插件视图里：协同绑定是异步的（连上、同步完、过闸
        // 之后才 reconfigure），视图的创建与更新是唯一能看到"ySync 出现了"的时机。
        view: (view) => {
          this.syncStoreAttachment(view.state);
          return {
            update: (updated) => this.syncStoreAttachment(updated.state),
            destroy: () => this.detachStore(),
          };
        },
      }),
    ];
  }

  bind(bridge: SessionBridge): void {
    this.bridge = bridge;
  }

  destroy(): void {
    this.detachStore();
    this.bridge = undefined;
  }

  /** 绑定或解绑共享批注表；表没换就什么都不做。 */
  private syncStoreAttachment(state: EditorState): void {
    const store = collabAnnotationStore(state);
    if (!store) {
      this.detachStore();
      return;
    }
    if (this.store?.handle === store.handle) {
      return;
    }
    this.detachStore();
    this.store = store;
    // 观察者跑在 Yjs 事务的调用栈上，派发 PM 事务要挪到微任务里，
    // 别在别人的栈上重入（与协同准入判断同一条纪律）。
    this.unobserve = store.observe(() => this.scheduleRefresh());
    // 后加入的协作者的首次投影同样走微任务：这里正站在 updateState 的
    // 插件视图阶段，当场派发事务是在 ProseMirror 自己的栈上重入。
    this.scheduleRefresh();
  }

  private detachStore(): void {
    this.unobserve?.();
    this.unobserve = undefined;
    this.store = undefined;
  }

  private scheduleRefresh(): void {
    if (this.refreshScheduled) {
      return;
    }
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (this.store) {
        this.dispatchMeta({ kind: "refresh" });
      }
    });
  }

  /** 装载文档时接收信封里的批注（runtime 调用，见 SessionExtension）。 */
  loadAnnotations(annotations: readonly Annotation[]): void {
    this.dispatchMeta({ kind: "seed", annotations: cloneJson(annotations) });
  }

  /** 当前批注表。信封序列化与宿主的 getAnnotations() 都从这里取。 */
  annotations(): readonly Annotation[] {
    const state = this.bridge?.getState();
    // 空表用同一个常量：runtime 按数组引用缓存只读包装，销毁后也要引用稳定。
    return state ? (commentKey.getState(state)?.annotations ?? EMPTY) : EMPTY;
  }

  readonly addCommand: SessionCommand = {
    run: (_session, apply, input) => {
      const bridge = this.bridge;
      if (!bridge) {
        return { ok: false, reason: "disabled", detail: "编辑器尚未就绪" };
      }
      const state = bridge.getState();
      if (state.selection.empty) {
        return { ok: false, reason: "invalid", detail: "请先选中要评论的文字" };
      }
      const { from, to } = anchorRange(state);
      if (to <= from) {
        return { ok: false, reason: "invalid", detail: "选中的内容没有可锚定的文字" };
      }
      const { id, payload } = addInputFrom(input);
      const annotationId = id ?? `comment-${crypto.randomUUID()}`;
      if (this.find(annotationId)) {
        return { ok: false, reason: "invalid", detail: `批注 ${annotationId} 已存在` };
      }
      if (!apply) {
        return { ok: true };
      }
      // payload 是调用方的对象，拷一份切断引用（§9.1 的隔离范围包含批注）。
      const stored = cloneJson(payload);
      if (this.store) {
        // 协同：写共享批注表，锚点在桥接层转成 Y.RelativePosition。随后同步
        // 派发一次重投影——观察者要等微任务，命令返回后批注就该立刻可见。
        if (!this.store.set(annotationId, stored, from, to)) {
          return { ok: false, reason: "invalid", detail: "选区无法锚定为批注" };
        }
        this.dispatchMeta({ kind: "refresh" });
        return { ok: true };
      }
      this.dispatchMeta({
        kind: "add",
        annotation: { id: annotationId, from, to, orphaned: false, payload: stored },
      });
      return { ok: true };
    },
    enabled: () => {
      const state = this.bridge?.getState();
      return state !== undefined && !state.selection.empty;
    },
    // 选区落在已有批注上时点亮，工具栏据此提示"这里已有评论"。
    active: () => {
      const state = this.bridge?.getState();
      if (!state) {
        return false;
      }
      const { from, to } = state.selection;
      return this.annotations().some(
        (annotation) => !annotation.orphaned && annotation.from <= to && annotation.to >= from,
      );
    },
  };

  readonly removeCommand: SessionCommand = {
    run: (_session, apply, input) => {
      const id = idFrom(input);
      if (!id || !this.find(id)) {
        return { ok: false, reason: "invalid", detail: "没有这条批注" };
      }
      if (!apply) {
        return { ok: true };
      }
      if (this.store) {
        this.store.remove(id);
        this.dispatchMeta({ kind: "refresh" });
        return { ok: true };
      }
      this.dispatchMeta({ kind: "remove", id });
      return { ok: true };
    },
    enabled: (_session, input) => {
      const id = idFrom(input);
      return id !== undefined && this.find(id);
    },
    active: () => false,
  };

  private find(id: string): boolean {
    if (this.store) {
      return this.store.has(id);
    }
    return this.annotations().some((annotation) => annotation.id === id);
  }

  private dispatchMeta(meta: CommentMeta): void {
    const bridge = this.bridge;
    if (!bridge) {
      return;
    }
    bridge.dispatch(bridge.getState().tr.setMeta(commentKey, meta));
  }

  private applyMeta(transaction: Transaction, value: CommentState): CommentState {
    const meta = transaction.getMeta(commentKey) as CommentMeta | undefined;
    if (this.store) {
      // 协同：远端事务与显式 refresh 都从共享表重投影——那时 Y.Doc 与位置映射
      // 都是新的。本地编辑事务只做扁平映射：此刻本地改动还没写回 Y.Doc，去解析
      // RelativePosition 得到的是上一拍的位置；而 Y 侧锚点锚在字符身份上，
      // 等 ySync 把本地改动写回后自然就位，不需要这里替它做什么。
      if (meta?.kind === "refresh" || isCollabChangeOrigin(transaction)) {
        const annotations = this.store.project(transaction.doc.content.size);
        return sameAnnotations(value.annotations, annotations) ? value : { annotations };
      }
      return mapThrough(transaction, value);
    }
    const mapped = mapThrough(transaction, value);
    if (!meta) {
      return mapped;
    }
    if (meta.kind === "add") {
      return { annotations: [...mapped.annotations, meta.annotation] };
    }
    if (meta.kind === "remove") {
      return {
        annotations: mapped.annotations.filter((annotation) => annotation.id !== meta.id),
      };
    }
    if (meta.kind === "seed") {
      return { annotations: meta.annotations };
    }
    return mapped;
  }
}

/**
 * 批注锚定的区间：把选区两端收进**紧邻字符的文本位置**——`to` 后退到"前面
 * 有字符"的位置，`from` 前进到"后面有字符"的位置。评论锚的是文字（§9.8），
 * 两端贴在块边界上时不收的话，协同锚点的 `to` 端（锚"区间内最后一个字符"）
 * 会落到块元素本身上，把整个没被选中的块圈进批注；文末位置的锚点还会退化成
 * type 锚定，翻转偏向后解析回文首。收完两端撞在一起说明选区里没有文字
 * （例如只选中了一个原子节点），那不是可锚定的批注目标。
 */
function anchorRange(state: EditorState): { from: number; to: number } {
  let { from, to } = state.selection;
  while (to > from) {
    const $to = state.doc.resolve(to);
    if ($to.parent.isTextblock && $to.parentOffset > 0) {
      break;
    }
    to -= 1;
  }
  while (from < to) {
    const $from = state.doc.resolve(from);
    if ($from.parent.isTextblock && $from.parentOffset < $from.parent.content.size) {
      break;
    }
    from += 1;
  }
  return { from, to };
}

/** 扁平锚点随事务映射；位置都没动时保住引用，宿主的订阅靠它少渲染。 */
function mapThrough(transaction: Transaction, value: CommentState): CommentState {
  if (!transaction.docChanged) {
    return value;
  }
  const mapped = value.annotations.map((annotation) =>
    mapAnnotation(transaction.mapping, annotation),
  );
  return mapped.some((annotation, index) => annotation !== value.annotations[index])
    ? { annotations: mapped }
    : value;
}

/** 投影没变时保住引用。payload 按引用比较：共享表里的对象没换过就还是同一个。 */
function sameAnnotations(left: readonly Annotation[], right: readonly Annotation[]): boolean {
  return (
    left.length === right.length &&
    left.every((annotation, index) => {
      const other = right[index] as Annotation;
      return (
        annotation.id === other.id &&
        annotation.from === other.from &&
        annotation.to === other.to &&
        annotation.orphaned === other.orphaned &&
        annotation.payload === other.payload
      );
    })
  );
}

/**
 * 把锚点迁移到新文档上。两端偏向刻意相反（与 §9.5 的 AI 回填同一条规则）：
 * `from` 偏后、`to` 偏前，紧贴批注外侧输入的文字留在批注之外——评论的是原来
 * 那段话，不该把新打的字圈进来。
 *
 * 区间被整段删除时两端撞在一起：置 `orphaned` 而不是丢弃（§9.8），批注本体
 * 与 payload 原样留存，位置坍缩到删除点。orphaned 在单机下不可逆——扁平位置
 * 无从知道"曾经锚过哪段文字"。
 */
function mapAnnotation(mapping: Mapping, annotation: Annotation): Annotation {
  if (annotation.orphaned) {
    const at = mapping.map(annotation.from, 1);
    return at === annotation.from ? annotation : { ...annotation, from: at, to: at };
  }
  const start = mapping.mapResult(annotation.from, 1);
  const end = mapping.mapResult(annotation.to, -1);
  if (end.pos <= start.pos) {
    return { ...annotation, from: start.pos, to: start.pos, orphaned: true };
  }
  if (start.pos === annotation.from && end.pos === annotation.to) {
    return annotation;
  }
  return { ...annotation, from: start.pos, to: end.pos };
}

function decorations(state: EditorState): DecorationSet {
  const annotations = commentKey.getState(state)?.annotations ?? [];
  const live = annotations.filter((annotation) => !annotation.orphaned);
  if (live.length === 0) {
    return DecorationSet.empty;
  }
  return DecorationSet.create(
    state.doc,
    live.map((annotation) =>
      Decoration.inline(annotation.from, annotation.to, {
        class: "co-comment",
        "data-comment-id": annotation.id,
      }),
    ),
  );
}

function addInputFrom(input: unknown): { id?: string; payload: unknown } {
  if (!input || typeof input !== "object") {
    return { payload: null };
  }
  const record = input as { id?: unknown; payload?: unknown };
  return {
    ...(typeof record.id === "string" && record.id.length > 0 ? { id: record.id } : {}),
    payload: record.payload ?? null,
  };
}

function idFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("id" in input)) {
    return undefined;
  }
  const id = (input as { id: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}
