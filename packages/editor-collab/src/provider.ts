import type { CollabPeer, CollabPeerIdentity, CollabStatus } from "@kaelen/editor-shared-types";
import type { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";
import type { CollabInboundFilter } from "./protocol";

/**
 * 协同 provider 契约（方案 §17）。
 *
 * 与 S12 的远端图片服务同一条立场：**传输是可替换的，策略不是。** 本仓库给出一个
 * WebSocket 实现和一个演示中继服务，宿主可以整体换成 WebRTC、自建长连接或任何
 * 已有的 Yjs provider——只要满足这个接口，`editor-pm-adapter` 那一侧不需要知道。
 *
 * Yjs 类型出现在这个接口上是有意的：`Y.Doc` 就是协同文档本身，把它藏起来只会
 * 逼每个实现去重新发明一遍。这个包因此和 `editor-pm-adapter` 同属桥接层，不进
 * 业务 API 表面（§7.1）。
 */
export interface CollabProvider {
  /** 协同文档。同一份文档的所有参与者共享它的更新历史。 */
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /**
   * 文档正文所在的共享片段名。同一协作文档的所有客户端必须一致，
   * 否则各写各的，谁也看不见谁。
   */
  readonly fragmentName: string;

  getStatus(): CollabStatus;
  /** 含本端自己，按 `id` 升序。 */
  getPeers(): readonly CollabPeer[];

  connect(): void;
  /** 断开但保留文档：重连后按 Yjs 的合并规则补齐，离线期间的编辑不丢。 */
  disconnect(): void;
  destroy(): void;

  /** 设置本端在别人光标上显示的名字与颜色。 */
  setLocalPeer(identity: CollabPeerIdentity): void;

  /**
   * 装上入站准入判断，`null` 卸下。
   *
   * 判断由适配层提供——只有它认识文档 Schema。provider 只负责在**写进 Y.Doc 之前**
   * 问一句：这笔更新引入的节点名和标记名，本端认得吗？认不得就整条不应用。晚一步
   * 就来不及了，理由见 `collectUpdateNames`。
   */
  setInboundFilter(filter: CollabInboundFilter | null): void;

  /**
   * 暂停/恢复入站更新。
   *
   * 组合态期间由会话调用（方案 §9.6）。远端更新如果照常落进 Y.Doc，
   * y-prosemirror 会立刻把整篇文档重建一遍——它内部没有任何组合态处理，而重建
   * 正在被输入法接管的那段 DOM 等于把用户打了一半的字抹掉。挡在 Yjs 这一层而不是
   * 去队列里重放事务：ySync 的 step 是"整篇替换"，重映射它没有意义；而 Yjs 是
   * CRDT，晚一点应用只影响看到的时机，不影响合并结果。
   */
  setInboundPaused(paused: boolean): void;

  onStatus(listener: (status: CollabStatus) => void): () => void;
  onPeers(listener: (peers: readonly CollabPeer[]) => void): () => void;
}

/** 一条已建立的连接。provider 只需要发送与关闭。 */
export interface CollabSocket {
  send(message: Uint8Array): void;
  close(): void;
}

/** 连接的生命周期回调，由 provider 提供给连接器。 */
export interface CollabSocketHandlers {
  onOpen(): void;
  onMessage(message: Uint8Array): void;
  /** 连接断开。provider 据此转入重连；`destroy()` 之后不再重连。 */
  onClose(): void;
}

/**
 * 打开一条连接。抽出来是为了让协同核心可以在没有 WebSocket 的环境里被测到——
 * 断连重连、组合态挂起这类行为不该只能靠起一个真服务端才验得了。
 */
export type CollabConnector = (handlers: CollabSocketHandlers) => CollabSocket;

/** 从 awareness 状态里读出协作者身份。 */
export function readPeers(awareness: Awareness): CollabPeer[] {
  const peers: CollabPeer[] = [];
  for (const [id, state] of awareness.getStates()) {
    const user = (state as { user?: Partial<CollabPeerIdentity> } | undefined)?.user;
    if (!user || typeof user.name !== "string" || typeof user.color !== "string") {
      continue;
    }
    peers.push({ id, name: user.name, color: user.color, local: id === awareness.clientID });
  }
  return peers.sort((left, right) => left.id - right.id);
}
