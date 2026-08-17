import { type CollabClientOptions, createCollabClient } from "./client";
import type { CollabProvider } from "./provider";

/**
 * 本包只用到 WebSocket 的这几样。用结构类型而不是 DOM 的 `WebSocket`：
 * 同一份实现要能跑在浏览器、Node 22 的内建 WebSocket 和 `ws` 上。
 */
export interface CollabWebSocket {
  binaryType: string;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  send(data: ArrayBufferLike | ArrayBufferView): void;
  close(): void;
}

export interface WebSocketCollabOptions extends Omit<CollabClientOptions, "connect"> {
  /** 服务地址，例如 `ws://127.0.0.1:4320`。房间名会作为路径拼在后面。 */
  url: string;
  room: string;
  /** 建立连接。缺省用全局 `WebSocket`；Node 或测试里可以换掉。 */
  openSocket?: (url: string) => CollabWebSocket;
}

/**
 * 本仓库提供的 WebSocket provider。
 *
 * 与 S12 的远端图片服务同一形态：这里给的是**一个能跑的实现和一份演示服务**
 * （`apps/collab-server`），不是唯一实现。宿主换成自己的长连接、WebRTC 或任何
 * 现成的 Yjs provider，都只需要满足 `CollabProvider`。
 */
export function createWebSocketCollabProvider(options: WebSocketCollabOptions): CollabProvider {
  const { url, room, openSocket, ...client } = options;
  const endpoint = `${url.replace(/\/$/, "")}/${encodeURIComponent(room)}`;

  return createCollabClient({
    ...client,
    connect: (handlers) => {
      const socket = (openSocket ?? defaultOpenSocket)(endpoint);
      socket.binaryType = "arraybuffer";
      let closed = false;
      const close = (): void => {
        if (closed) {
          return;
        }
        closed = true;
        handlers.onClose();
      };
      socket.addEventListener("open", () => handlers.onOpen());
      socket.addEventListener("message", (event) => {
        const data = event.data;
        if (data instanceof ArrayBuffer) {
          handlers.onMessage(new Uint8Array(data));
          return;
        }
        if (ArrayBuffer.isView(data)) {
          handlers.onMessage(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        }
        // 文本帧不是本协议的一部分，直接忽略。
      });
      // error 与 close 都可能先到，也可能只到一个；`close` 自己去重，
      // 免得一次断开被算成两次、退避直接跳档。
      socket.addEventListener("error", close);
      socket.addEventListener("close", close);
      return {
        send: (message) => {
          try {
            socket.send(message);
          } catch {
            // 连接正在关闭时 send 会抛。这一笔更新会在重连后的同步里补回来。
          }
        },
        close: () => {
          closed = true;
          socket.close();
        },
      };
    },
  });
}

function defaultOpenSocket(url: string): CollabWebSocket {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => CollabWebSocket }).WebSocket;
  if (!Ctor) {
    throw new Error("当前环境没有 WebSocket，请通过 openSocket 提供一个实现");
  }
  return new Ctor(url);
}
