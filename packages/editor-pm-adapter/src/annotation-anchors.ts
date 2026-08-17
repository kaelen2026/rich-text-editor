import type { Annotation } from "@kaelen/editor-shared-types";
import type { Node as ProseMirrorNode } from "prosemirror-model";
import type { EditorState, Transaction } from "prosemirror-state";
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from "y-prosemirror";
import * as Y from "yjs";

/**
 * 共享批注表在 `Y.Doc` 里的顶层名字。与正文的 XmlFragment（`fragmentName`，
 * 默认 `prosemirror`）并列——同一份 Y.Doc，因此批注和它锚定的文字在同一笔
 * 更新里到达，不存在"文字到了、评论还在路上"的中间态。
 */
const ANNOTATION_MAP_NAME = "annotations";

/**
 * 共享批注表里的一条记录。锚点是编码后的 `Y.RelativePosition`：它锚在字符的
 * 身份（client, clock）上而不是偏移量上，远端的整篇替换事务动不了它——这正是
 * §9.8 说的"M4 引入 Yjs 后 from/to 迁移为 Y.RelativePosition"。
 */
interface StoredAnnotation {
  id: string;
  from: Uint8Array;
  to: Uint8Array;
  payload: unknown;
}

/**
 * 协同批注表的桥接接口。Yjs 与 y-prosemirror 的知识收在本模块（桥接层止于
 * adapter / 插件层，方案 §7.1）；评论插件只消费这个窄接口，不认识任何 Y 类型。
 */
export interface CollabAnnotationStore {
  /**
   * 身份句柄：同一份共享批注表返回同一个对象。插件用它判断"还是不是刚才
   * 订阅的那张表"，避免重复挂观察者。
   */
  readonly handle: object;
  /** 写入一条批注，锚点取自当前文档位置。区间无法锚定时返回 false。 */
  set(id: string, payload: unknown, from: number, to: number): boolean;
  remove(id: string): void;
  has(id: string): boolean;
  /**
   * 把共享批注表投影成当前文档上的扁平批注。区间已坍缩（锚定内容被删）的
   * 置 `orphaned`；结果按 `from` 升序、同位按 `id`，各端因此有一致的展示顺序。
   */
  project(maxPos: number): Annotation[];
  /**
   * 订阅共享表的变化（本端写入与远端更新都触发）。回调发生在 Yjs 事务的
   * 观察者栈上——调用方要派发 PM 事务必须先挪到微任务里，别在别人的栈上重入。
   * 返回退订函数。
   */
  observe(listener: () => void): () => void;
}

/**
 * 从编辑器状态取协同批注表。未绑定协同（没有 ySync 插件）时返回 null，
 * 调用方据此回落到单机的扁平锚点。
 */
export function collabAnnotationStore(state: EditorState): CollabAnnotationStore | null {
  const sync = ySyncPluginKey.getState(state) as
    | {
        type: Y.XmlFragment;
        doc: Y.Doc;
        binding: {
          mapping: Map<Y.AbstractType<unknown>, ProseMirrorNode | ProseMirrorNode[]>;
        };
      }
    | undefined;
  if (!sync?.binding || !sync.doc) {
    return null;
  }
  const { doc, type: fragment, binding } = sync;
  const map = doc.getMap<StoredAnnotation>(ANNOTATION_MAP_NAME);

  const encode = (position: number, assoc: 0 | -1): Uint8Array | null => {
    // `to` 端锚在区间内最后一个字符上（assoc -1）：贴着终点输入的新字落在
    // 批注之外，最后一个字符被删时位置坍缩到删除点——与单机 mapRange 的
    // "两端偏向相反"是同一条语义。`from` 端锚在第一个字符上（assoc 0），对称成立。
    const at = assoc < 0 ? position - 1 : position;
    const relative = absolutePositionToRelativePosition(at, fragment, binding.mapping);
    if (!relative) {
      return null;
    }
    if (assoc < 0) {
      const json = Y.relativePositionToJSON(relative) as Record<string, unknown>;
      json.assoc = -1;
      return Y.encodeRelativePosition(Y.createRelativePositionFromJSON(json));
    }
    return Y.encodeRelativePosition(relative);
  };

  const resolve = (bytes: Uint8Array): number | null =>
    relativePositionToAbsolutePosition(
      doc,
      fragment,
      Y.decodeRelativePosition(bytes),
      binding.mapping,
    );

  return {
    handle: map,

    set(id: string, payload: unknown, from: number, to: number): boolean {
      if (to <= from) {
        return false;
      }
      const anchorFrom = encode(from, 0);
      const anchorTo = encode(to, -1);
      if (!anchorFrom || !anchorTo) {
        return false;
      }
      map.set(id, { id, from: anchorFrom, to: anchorTo, payload });
      return true;
    },

    remove(id: string): void {
      map.delete(id);
    },

    has(id: string): boolean {
      return map.has(id);
    },

    project(maxPos: number): Annotation[] {
      const annotations: Annotation[] = [];
      for (const stored of map.values()) {
        const from = resolve(stored.from);
        const to = resolve(stored.to);
        // 两端撞在一起（或锚点所在结构整个没了）就是"锚定内容已删除"：
        // 置 orphaned 而不是丢弃（§9.8），位置坍缩到还能确定的那一端。
        const orphaned = from === null || to === null || to <= from;
        const at = clamp(from ?? to ?? 0, maxPos);
        annotations.push({
          id: stored.id,
          from: orphaned ? at : clamp(from as number, maxPos),
          to: orphaned ? at : clamp(to as number, maxPos),
          orphaned,
          payload: stored.payload,
        });
      }
      return annotations.sort((left, right) => left.from - right.from || compareIds(left, right));
    },

    observe(listener: () => void): () => void {
      const handler = (): void => listener();
      map.observe(handler);
      return () => map.unobserve(handler);
    },
  };
}

/** 远端来的事务：ySync 把共享文档的变化整篇写回本地时会打上这个标记。 */
export function isCollabChangeOrigin(transaction: Transaction): boolean {
  const meta = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  return meta?.isChangeOrigin === true;
}

function clamp(position: number, maxPos: number): number {
  return Math.max(0, Math.min(position, maxPos));
}

function compareIds(left: Annotation, right: Annotation): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
