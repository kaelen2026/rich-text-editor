import type { CollabPeer, CollabPeerIdentity, CollabStatus } from "@kaelen/editor-shared-types";
import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  applyMessage,
  type CollabInboundFilter,
  encodeAwareness,
  encodeDocumentUpdate,
  encodeSyncStep1,
} from "./protocol";
import {
  type CollabConnector,
  type CollabProvider,
  type CollabSocket,
  readPeers,
} from "./provider";

/**
 * 从网络进来的改动统一用这个 origin 标记。本端据此区分"自己改的"和"别人改的"：
 * 少了它，刚收到的更新会被当成本地改动再广播回去。
 */
const NETWORK = Symbol("collab-network");

export interface CollabClientOptions {
  connect: CollabConnector;
  /** 复用已有文档（例如已经装过内容的那一份）；缺省新建。 */
  doc?: Y.Doc;
  fragmentName?: string;
  peer?: CollabPeerIdentity;
  /** 第 `attempt` 次重连前等待的毫秒数，从 0 开始。默认指数退避、上限 10 秒。 */
  reconnectDelayMs?: (attempt: number) => number;
  /** 创建后立刻连接，默认 true。 */
  autoConnect?: boolean;
}

const DEFAULT_BACKOFF = (attempt: number): number => Math.min(10_000, 300 * 2 ** attempt);

/**
 * 传输无关的协同客户端。
 *
 * 把连接抽成 `CollabConnector` 而不是直接写死 WebSocket，是为了让断连重连、
 * 组合态挂起这些**行为**能在没有服务端的情况下被测到。真实 WebSocket 只是它的
 * 一个连接器（见 `websocket-provider.ts`）。
 */
export function createCollabClient(options: CollabClientOptions): CollabProvider {
  const doc = options.doc ?? new Y.Doc();
  const awareness = new Awareness(doc);
  const fragmentName = options.fragmentName ?? "prosemirror";
  const backoff = options.reconnectDelayMs ?? DEFAULT_BACKOFF;

  let socket: CollabSocket | null = null;
  let status: CollabStatus = "disconnected";
  let shouldConnect = false;
  let destroyed = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let opening = false;
  let inboundFilter: CollabInboundFilter | null = null;
  const inbox: Uint8Array[] = [];
  /**
   * 连接刚建立、`socket` 还没赋值时要发的字节。
   *
   * 对端在连上的第一刻就会送来它的 syncStep1，而应答要在同一个调用栈里发出去——
   * 那时 `options.connect()` 还没返回。少了这个缓冲，那条应答会被静默丢掉，于是
   * 服务端永远不知道本端离线期间写了什么，直到用户下一次按键才补上。
   */
  const outbox: Uint8Array[] = [];

  const statusListeners = new Set<(value: CollabStatus) => void>();
  const peerListeners = new Set<(value: readonly CollabPeer[]) => void>();

  const setStatus = (next: CollabStatus): void => {
    if (status === next) {
      return;
    }
    status = next;
    for (const listener of statusListeners) {
      listener(next);
    }
  };

  const notifyPeers = (): void => {
    const peers = readPeers(awareness);
    for (const listener of peerListeners) {
      listener(peers);
    }
  };

  const send = (message: Uint8Array): void => {
    if (socket) {
      socket.send(message);
      return;
    }
    if (opening) {
      outbox.push(message);
      return;
    }
    // 完全没连接时直接丢：状态都在 Y.Doc 里，重连后的握手会把它补齐。
  };

  const deliver = (message: Uint8Array): void => {
    let applied: ReturnType<typeof applyMessage>;
    try {
      applied = applyMessage(message, { doc, awareness }, NETWORK, {
        accept: inboundFilter ?? undefined,
      });
    } catch {
      // 畸形消息只丢这一条。断开重连解决不了格式问题，反而会把整条会话拖垮。
      return;
    }
    if (applied.reply) {
      send(applied.reply);
    }
    if (applied.documentApplied && status === "connected") {
      setStatus("synced");
    }
  };

  const flushInbox = (): void => {
    while (inbox.length > 0) {
      const message = inbox.shift();
      if (message) {
        deliver(message);
      }
    }
  };

  const clearReconnect = (): void => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const dropRemotePeers = (): void => {
    const remote = [...awareness.getStates().keys()].filter((id) => id !== doc.clientID);
    if (remote.length > 0) {
      removeAwarenessStates(awareness, remote, NETWORK);
    }
  };

  const open = (): void => {
    if (destroyed || socket) {
      return;
    }
    setStatus("connecting");
    opening = true;
    let opened: CollabSocket;
    try {
      opened = options.connect({
        onOpen: () => {
          attempt = 0;
          setStatus("connected");
          // 先要对方的状态，再把自己的身份铺出去。顺序反了别人会先看到一个
          // 还没有内容的光标。
          send(encodeSyncStep1(doc));
          const local = awareness.getLocalState();
          if (local !== null) {
            // 重发前必须让本端的 awareness 时钟前进一格。对端在我们断开时把这条
            // 状态删了，却记着它当时的时钟；原样重发会被当成"已经见过的旧值"丢掉，
            // 于是重连之后本端的光标在别人那里再也不出现。
            awareness.setLocalState({ ...local });
          }
        },
        onMessage: (message) => {
          if (paused) {
            inbox.push(message);
            return;
          }
          deliver(message);
        },
        onClose: () => {
          socket = null;
          // 断开后别人的光标必须立刻消失：留着它们等于告诉用户"对方还在看"。
          dropRemotePeers();
          setStatus("disconnected");
          if (shouldConnect && !destroyed) {
            reconnectTimer = setTimeout(open, backoff(attempt));
            attempt += 1;
          }
        },
      });
    } finally {
      opening = false;
    }
    socket = opened;
    for (const message of outbox.splice(0)) {
      opened.send(message);
    }
  };

  const onDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === NETWORK) {
      return;
    }
    send(encodeDocumentUpdate(update));
  };

  const onAwarenessUpdate = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin !== NETWORK) {
      send(encodeAwareness(awareness, [...changes.added, ...changes.updated, ...changes.removed]));
    }
    notifyPeers();
  };

  doc.on("update", onDocumentUpdate);
  awareness.on("update", onAwarenessUpdate);

  if (options.peer) {
    awareness.setLocalStateField("user", options.peer);
  }
  if (options.autoConnect !== false) {
    shouldConnect = true;
    open();
  }

  return {
    doc,
    awareness,
    fragmentName,
    getStatus: () => status,
    getPeers: () => readPeers(awareness),

    connect() {
      if (destroyed) {
        return;
      }
      shouldConnect = true;
      attempt = 0;
      clearReconnect();
      open();
    },

    disconnect() {
      shouldConnect = false;
      clearReconnect();
      const current = socket;
      socket = null;
      // 主动断开时连接器不一定会回调 onClose，状态与光标在这里自己收干净。
      current?.close();
      dropRemotePeers();
      setStatus("disconnected");
    },

    destroy() {
      destroyed = true;
      shouldConnect = false;
      clearReconnect();
      socket?.close();
      socket = null;
      inbox.length = 0;
      doc.off("update", onDocumentUpdate);
      awareness.off("update", onAwarenessUpdate);
      awareness.destroy();
      statusListeners.clear();
      peerListeners.clear();
    },

    setInboundFilter(filter: CollabInboundFilter | null) {
      inboundFilter = filter;
    },

    setLocalPeer(identity: CollabPeerIdentity) {
      awareness.setLocalStateField("user", identity);
    },

    setInboundPaused(next: boolean) {
      if (paused === next) {
        return;
      }
      paused = next;
      if (!paused) {
        // 连接已经断了也照样冲刷：这些是合法的 CRDT 更新，晚一点应用只影响
        // 看到的时机，不影响合并结果。
        flushInbox();
      }
    },

    onStatus(listener) {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },

    onPeers(listener) {
      peerListeners.add(listener);
      return () => peerListeners.delete(listener);
    },
  };
}
