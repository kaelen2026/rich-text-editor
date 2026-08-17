import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { type Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { readSyncMessage, writeSyncStep1, writeSyncStep2, writeUpdate } from "y-protocols/sync";
import type * as Y from "yjs";

/**
 * 线上消息格式。
 *
 * 信封只有一个字节：消息类型。文档同步与 awareness 的具体编码全部交给
 * `y-protocols`——那是 Yjs 生态里事实上的格式，自造一套只会让这个仓库的服务端
 * 与任何现成实现互不相通，而 §17 要的是可替换的 provider，不是自成一派的协议。
 *
 * 客户端与服务端共用同一份编解码：中继服务本身也是一个 Yjs 参与者（它持有房间的
 * Y.Doc），两边处理消息的规则因此没有理由不同。
 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/** 一端持有的协同状态。客户端与服务端房间是同一个形状。 */
export interface CollabEndpoint {
  doc: Y.Doc;
  awareness: Awareness;
}

/** 请求对端把它有而本端没有的文档状态发过来。连接建立后的第一条消息。 */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** 把本端相对于对端状态向量的增量发过去。 */
export function encodeSyncStep2(doc: Y.Doc, stateVector?: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  writeSyncStep2(encoder, doc, stateVector);
  return encoding.toUint8Array(encoder);
}

/** 本端产生的一笔文档更新。 */
export function encodeDocumentUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** 指定若干客户端的 awareness 状态。清场时用它广播"这些人已离开"。 */
export function encodeAwareness(awareness: Awareness, clients: number[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, clients));
  return encoding.toUint8Array(encoder);
}

/** `applyMessage` 的结果：需要回给对端的字节，以及这条消息是不是同步应答。 */
export interface AppliedMessage {
  /** 有内容时必须原样发回给来源那一端。 */
  reply?: Uint8Array;
  /** 收到的是 syncStep2 或 update，也就是文档内容真的到了。 */
  documentApplied: boolean;
}

/**
 * 处理一条收到的消息，必要时给出应答。
 *
 * `origin` 会成为 Yjs 事务的 origin，本端据此区分"自己改的"和"远端来的"——
 * 少了它，把远端更新写进本地文档会立刻被当成本地改动再广播一次，两端来回弹。
 *
 * 畸形消息会抛错（`y-protocols` 对未知的同步子类型直接抛）。这里刻意不吞：
 * 消息来自网络对端，是否要因此断开那一条连接是调用方的策略，不是编解码的。
 */
export function applyMessage(
  message: Uint8Array,
  endpoint: CollabEndpoint,
  origin: unknown,
): AppliedMessage {
  const decoder = decoding.createDecoder(message);
  const type = decoding.readVarUint(decoder);
  if (type === MESSAGE_AWARENESS) {
    applyAwarenessUpdate(endpoint.awareness, decoding.readVarUint8Array(decoder), origin);
    return { documentApplied: false };
  }
  if (type !== MESSAGE_SYNC) {
    // 未知消息类型直接忽略：协议要能往前加类型，旧端不该因此断开。
    return { documentApplied: false };
  }
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  const syncType = readSyncMessage(decoder, encoder, endpoint.doc, origin);
  // readSyncMessage 只在收到 step1 时往 encoder 里写应答；其余情况只有那个类型字节。
  const reply = encoding.length(encoder) > 1 ? encoding.toUint8Array(encoder) : undefined;
  return { reply, documentApplied: syncType !== 0 };
}
