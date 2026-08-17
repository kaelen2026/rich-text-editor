import { Awareness, removeAwarenessStates } from "y-protocols/awareness";
import * as Y from "yjs";
import { applyMessage, encodeAwareness, encodeDocumentUpdate, encodeSyncStep1 } from "./protocol";
import type { CollabSocket } from "./provider";

/** 一条已加入房间的连接。 */
export interface CollabRoomConnection {
  /** 处理来自这条连接的一条消息。畸形消息只丢这一条，不影响房间。 */
  receive(message: Uint8Array): void;
  leave(): void;
}

/**
 * 服务端房间。
 *
 * 中继服务自己就是一个 Yjs 参与者：它持有房间的 Y.Doc，因此后到的客户端可以从它
 * 那里补齐全部历史，而不必等某个"第一个进来的人"还在线。这也是不做纯转发的原因
 * ——纯转发的房间一旦所有人都离开，文档就没了。
 *
 * 房间只搬运字节，不认识文档结构：它没有 Schema，也不该有。内容的合法性由每个
 * 客户端自己的 Schema 决定（见 `collectSharedNames` 与适配层的兼容闸门）。
 */
export class CollabRoom {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);

  private readonly connections = new Map<CollabRoomConnection, CollabSocket>();
  /** 每条连接带进来的 awareness 客户端号，断开时据此清场。 */
  private readonly owned = new Map<CollabRoomConnection, Set<number>>();

  constructor(readonly name: string) {
    // 房间自己不产生 awareness 状态，因此本地状态置空，别人不会看到一个幽灵光标。
    this.awareness.setLocalState(null);
    this.doc.on("update", this.broadcastDocumentUpdate);
    this.awareness.on("update", this.broadcastAwareness);
  }

  get size(): number {
    return this.connections.size;
  }

  join(socket: CollabSocket): CollabRoomConnection {
    const connection: CollabRoomConnection = {
      receive: (message) => this.receive(connection, message),
      leave: () => this.leave(connection),
    };
    this.connections.set(connection, socket);
    this.owned.set(connection, new Set());

    socket.send(encodeSyncStep1(this.doc));
    const present = [...this.awareness.getStates().keys()];
    if (present.length > 0) {
      socket.send(encodeAwareness(this.awareness, present));
    }
    return connection;
  }

  destroy(): void {
    for (const connection of [...this.connections.keys()]) {
      this.leave(connection);
    }
    this.doc.off("update", this.broadcastDocumentUpdate);
    this.awareness.off("update", this.broadcastAwareness);
    this.awareness.destroy();
    this.doc.destroy();
  }

  private receive(connection: CollabRoomConnection, message: Uint8Array): void {
    const socket = this.connections.get(connection);
    if (!socket) {
      return;
    }
    try {
      const applied = applyMessage(
        message,
        { doc: this.doc, awareness: this.awareness },
        connection,
      );
      if (applied.reply) {
        socket.send(applied.reply);
      }
    } catch {
      // 客户端发来的字节是不可信输入。一条解不开的消息不该掀掉整个房间，
      // 也不该连累同一房间里的其他人。
    }
  }

  private leave(connection: CollabRoomConnection): void {
    if (!this.connections.delete(connection)) {
      return;
    }
    const clients = this.owned.get(connection);
    this.owned.delete(connection);
    if (clients && clients.size > 0) {
      // 用这条连接做 origin，广播时它已经不在表里，天然不会收到自己的清场通知。
      removeAwarenessStates(this.awareness, [...clients], connection);
    }
  }

  private readonly broadcastDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    this.broadcast(encodeDocumentUpdate(update), origin);
  };

  private readonly broadcastAwareness = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    this.trackOwnership(changes, origin);
    this.broadcast(encodeAwareness(this.awareness, changed), origin);
  };

  /** 记住每个 awareness 客户端是从哪条连接进来的，供断开时清场。 */
  private trackOwnership(
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void {
    const owned = this.owned.get(origin as CollabRoomConnection);
    if (!owned) {
      return;
    }
    for (const client of [...changes.added, ...changes.updated]) {
      owned.add(client);
    }
    for (const client of changes.removed) {
      owned.delete(client);
    }
  }

  private broadcast(message: Uint8Array, origin: unknown): void {
    for (const [connection, socket] of this.connections) {
      if (connection === origin) {
        continue;
      }
      socket.send(message);
    }
  }
}
