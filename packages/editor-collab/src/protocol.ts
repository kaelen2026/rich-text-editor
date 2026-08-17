import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { type Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { writeSyncStep1, writeSyncStep2, writeUpdate } from "y-protocols/sync";
import * as Y from "yjs";
import { collectUpdateNames, type SharedDocumentNames } from "./inspect";

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

/** `y-protocols/sync` 的同步子类型。分发在本文件里手写，见 `applyMessage`。 */
const SYNC_STEP1 = 0;
const SYNC_STEP2 = 1;
const SYNC_UPDATE = 2;

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

/**
 * 入站更新的准入判断。返回 false 的更新一律不会被写进文档。
 *
 * 存在的理由见 `collectUpdateNames`：本端 Schema 不认识的名字一旦进了 Y.Doc，
 * y-prosemirror 会替所有人把那段内容删掉。因此判断只能发生在应用之前。
 */
export type CollabInboundFilter = (names: SharedDocumentNames) => boolean;

/** `applyMessage` 的结果。 */
export interface AppliedMessage {
  /** 有内容时必须原样发回给来源那一端。 */
  reply?: Uint8Array;
  /** 收到的是 syncStep2 或 update，也就是文档内容真的到了。 */
  documentApplied: boolean;
  /** 更新被准入判断挡下，文档一字未动。带上它引入的名字，供上报。 */
  rejected?: SharedDocumentNames;
}

export interface ApplyMessageOptions {
  accept?: CollabInboundFilter;
}

/**
 * 处理一条收到的消息，必要时给出应答。
 *
 * `origin` 会成为 Yjs 事务的 origin，本端据此区分"自己改的"和"远端来的"——
 * 少了它，把远端更新写进本地文档会立刻被当成本地改动再广播一次，两端来回弹。
 *
 * 同步子类型在这里手写分发，而不是交给 `y-protocols` 的 `readSyncMessage`：
 * 准入判断必须插在"取出更新字节"和"应用它"之间，而那个函数把两步焊死了。
 * 编码仍然全部走 y-protocols，线上格式与任何现成实现一致。
 *
 * 畸形消息会抛错。这里刻意不吞：消息来自网络对端，是否要因此断开那一条连接
 * 是调用方的策略，不是编解码的。
 */
export function applyMessage(
  message: Uint8Array,
  endpoint: CollabEndpoint,
  origin: unknown,
  options: ApplyMessageOptions = {},
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

  const syncType = decoding.readVarUint(decoder);
  if (syncType === SYNC_STEP1) {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    writeSyncStep2(encoder, endpoint.doc, decoding.readVarUint8Array(decoder));
    return { reply: encoding.toUint8Array(encoder), documentApplied: false };
  }
  if (syncType !== SYNC_STEP2 && syncType !== SYNC_UPDATE) {
    throw new Error(`未知的同步消息类型：${syncType}`);
  }

  const update = decoding.readVarUint8Array(decoder);
  if (options.accept) {
    // 只有装了准入判断才解更新结构：没装的一端（例如中继房间）不为它付出解码成本。
    const names = collectUpdateNames(update);
    if (!options.accept(names)) {
      return { documentApplied: false, rejected: names };
    }
  }
  Y.applyUpdate(endpoint.doc, update, origin);
  return { documentApplied: true };
}
