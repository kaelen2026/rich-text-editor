import { createServer } from "node:http";
import { CollabRoom } from "@kaelen/editor-collab";
import { WebSocketServer } from "ws";

/**
 * 协同演示中继服务。
 *
 * 与 `apps/remote-image-service` 同一定位：**它是一个能跑的例子，不是产品的一部分。**
 * 房间逻辑（谁持有文档、消息怎么分发、断线怎么清场）全部在
 * `@kaelen/editor-collab` 里，这里只负责把 WebSocket 帧接上去。宿主换成自己的
 * 网关、鉴权和持久化，只需要重写这一层。
 *
 * 刻意没有做的三件事，因为它们是产品决策不是演示内容：鉴权与房间权限、
 * 文档持久化（进程退出即丢）、房间数量上限。
 */
const port = Number(process.env.COLLAB_PORT ?? 4320);
const rooms = new Map<string, CollabRoom>();

const server = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("ok");
    return;
  }
  response.writeHead(426).end("本服务只接受 WebSocket 连接");
});

const sockets = new WebSocketServer({ server });

sockets.on("connection", (socket, request) => {
  const name = roomName(request.url);
  // 房间在最后一个人离开后仍然留着：文档的事实来源是它持有的 Y.Doc，
  // 一散场就销毁等于"所有人退出即丢文档"。演示服务因此只在进程退出时丢。
  const room = rooms.get(name) ?? new CollabRoom(name);
  rooms.set(name, room);

  const connection = room.join({
    send: (message) => {
      // 连接正在关闭时 send 会抛；那一笔更新会在对端重连后的同步里补回来。
      try {
        socket.send(message);
      } catch {
        socket.terminate();
      }
    },
    close: () => socket.close(),
  });

  socket.binaryType = "nodebuffer";
  socket.on("message", (data) => {
    connection.receive(toBytes(data));
  });
  socket.on("close", () => connection.leave());
  socket.on("error", () => connection.leave());
});

server.listen(port, () => {
  console.log(`协同演示服务已启动：ws://127.0.0.1:${port}/<房间名>`);
});

/** 路径的第一段就是房间名；缺省落到 `default`。 */
function roomName(url: string | undefined): string {
  const path = (url ?? "/").split("?")[0] ?? "/";
  const segment = path.split("/").filter(Boolean)[0];
  return segment ? decodeURIComponent(segment) : "default";
}

/** `ws` 会按帧的分片情况给出 Buffer、Buffer 数组或 ArrayBuffer。 */
function toBytes(data: unknown): Uint8Array {
  if (Array.isArray(data)) {
    return toBytes(Buffer.concat(data));
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new Uint8Array();
}
