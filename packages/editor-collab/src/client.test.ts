import type { CollabPeerIdentity } from "@kaelen/editor-shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCollabClient } from "./client";
import type { CollabConnector, CollabProvider, CollabSocketHandlers } from "./provider";
import { CollabRoom, type CollabRoomConnection } from "./room";

/**
 * 一根内存里的网线。
 *
 * 断连重连、组合态挂起都是**行为**，不该只能靠起一个真服务端才验得了；真实
 * WebSocket 那一层留给 e2e。`cut()` 模拟网络断开（客户端会重连），`unplug()`
 * 模拟本端主动关闭。
 */
class Wire {
  private connection: CollabRoomConnection | undefined;
  private handlers: CollabSocketHandlers | undefined;
  private live = true;

  constructor(private readonly room: CollabRoom) {}

  readonly connect: CollabConnector = (handlers) => {
    this.handlers = handlers;
    this.live = true;
    this.connection = this.room.join({
      send: (message) => {
        if (this.live) {
          handlers.onMessage(message);
        }
      },
      close: () => this.cut(),
    });
    // 真实连接是异步打开的，`onOpen` 也就不会先于 join 的第一条消息发生。
    queueMicrotask(() => {
      if (this.live) {
        handlers.onOpen();
      }
    });
    return {
      send: (message) => {
        if (this.live) {
          this.connection?.receive(message);
        }
      },
      close: () => this.unplug(),
    };
  };

  /** 网络断开：客户端会收到 onClose 并进入重连。 */
  cut(): void {
    const notify = this.live;
    this.unplug();
    if (notify) {
      this.handlers?.onClose();
    }
  }

  private unplug(): void {
    this.live = false;
    this.connection?.leave();
    this.connection = undefined;
  }
}

const rooms: CollabRoom[] = [];
const providers: CollabProvider[] = [];

function room(): CollabRoom {
  const created = new CollabRoom("s28");
  rooms.push(created);
  return created;
}

function client(target: CollabRoom, peer?: CollabPeerIdentity): CollabProvider {
  const provider = createCollabClient({
    connect: new Wire(target).connect,
    peer,
    reconnectDelayMs: () => 5,
  });
  providers.push(provider);
  return provider;
}

/** 客户端一侧的网线。断线用例要拿它拔。 */
function wiredClient(
  target: CollabRoom,
  peer?: CollabPeerIdentity,
): { provider: CollabProvider; wire: Wire } {
  const wire = new Wire(target);
  const provider = createCollabClient({
    connect: wire.connect,
    peer,
    reconnectDelayMs: () => 5,
  });
  providers.push(provider);
  return { provider, wire };
}

const body = (provider: CollabProvider): string => provider.doc.getText("body").toString();

afterEach(() => {
  while (providers.length > 0) {
    providers.pop()?.destroy();
  }
  while (rooms.length > 0) {
    rooms.pop()?.destroy();
  }
});

describe("协同客户端", () => {
  it("两端汇合到同一份内容", async () => {
    const hub = room();
    const left = client(hub);
    const right = client(hub);

    await vi.waitFor(() => expect(left.getStatus()).toBe("synced"));
    left.doc.getText("body").insert(0, "左边写的");

    await vi.waitFor(() => expect(body(right)).toBe("左边写的"));
  });

  it("后到的客户端补齐全部历史，房间在无人时也留着文档", async () => {
    const hub = room();
    const first = client(hub);
    await vi.waitFor(() => expect(first.getStatus()).toBe("synced"));
    first.doc.getText("body").insert(0, "先写的");
    await vi.waitFor(() => expect(hub.doc.getText("body").toString()).toBe("先写的"));

    first.destroy();
    expect(hub.size).toBe(0);

    const late = client(hub);
    await vi.waitFor(() => expect(body(late)).toBe("先写的"));
  });

  it("入站暂停期间远端改动不落地，恢复后一次到位", async () => {
    const hub = room();
    const left = client(hub);
    const right = client(hub);
    await vi.waitFor(() => expect(right.getStatus()).toBe("synced"));

    right.setInboundPaused(true);
    left.doc.getText("body").insert(0, "组合期间的远端改动");

    // 让消息有充分的时间跑完全程：挡住它的是暂停，不是还没送到。
    await vi.waitFor(() => expect(hub.doc.getText("body").toString()).toBe("组合期间的远端改动"));
    expect(body(right)).toBe("");

    right.setInboundPaused(false);
    expect(body(right)).toBe("组合期间的远端改动");
  });

  it("入站暂停不挡出站：本端编辑照常广播出去", async () => {
    const hub = room();
    const left = client(hub);
    const right = client(hub);
    await vi.waitFor(() => expect(right.getStatus()).toBe("synced"));

    right.setInboundPaused(true);
    right.doc.getText("body").insert(0, "本端仍在打字");

    await vi.waitFor(() => expect(body(left)).toBe("本端仍在打字"));
  });

  it("断线期间两边各自编辑，重连后互相补齐且都不丢", async () => {
    const hub = room();
    const online = client(hub);
    const flaky = wiredClient(hub);
    await vi.waitFor(() => expect(flaky.provider.getStatus()).toBe("synced"));

    flaky.wire.cut();
    await vi.waitFor(() => expect(flaky.provider.getStatus()).toBe("disconnected"));

    online.doc.getText("body").insert(0, "在线端写的。");
    flaky.provider.doc.getText("body").insert(0, "离线端写的。");

    await vi.waitFor(() => expect(flaky.provider.getStatus()).toBe("synced"));
    await vi.waitFor(() => {
      expect(body(flaky.provider)).toContain("在线端写的。");
      expect(body(flaky.provider)).toContain("离线端写的。");
      expect(body(online)).toBe(body(flaky.provider));
    });
  });

  it("断开后对方的光标立刻消失，重连后回来", async () => {
    const hub = room();
    const watcher = client(hub, { name: "看的人", color: "#112233" });
    const flaky = wiredClient(hub, { name: "断的人", color: "#445566" });

    // `readPeers` 按 clientID 排序，名字的先后因此不确定，比集合而不是比顺序。
    const names = (provider: CollabProvider): Set<string> =>
      new Set(provider.getPeers().map((peer) => peer.name));

    await vi.waitFor(() => {
      expect(names(watcher)).toEqual(new Set(["断的人", "看的人"]));
    });

    flaky.wire.cut();
    await vi.waitFor(() => {
      expect(names(watcher)).toEqual(new Set(["看的人"]));
      // 断开的一端同样看不到别人了，不该停在"对方还在看"的画面上。
      expect(names(flaky.provider)).toEqual(new Set(["断的人"]));
    });

    await vi.waitFor(() => {
      expect(names(watcher)).toEqual(new Set(["断的人", "看的人"]));
    });
  });

  it("主动断开不重连，再 connect 才回来", async () => {
    const hub = room();
    const provider = client(hub);
    await vi.waitFor(() => expect(provider.getStatus()).toBe("synced"));

    provider.disconnect();
    expect(provider.getStatus()).toBe("disconnected");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(provider.getStatus()).toBe("disconnected");

    provider.connect();
    await vi.waitFor(() => expect(provider.getStatus()).toBe("synced"));
  });

  it("身份变更广播给其他人", async () => {
    const hub = room();
    const watcher = client(hub, { name: "看的人", color: "#112233" });
    const mover = client(hub, { name: "旧名字", color: "#445566" });
    await vi.waitFor(() => expect(watcher.getPeers()).toHaveLength(2));

    mover.setLocalPeer({ name: "新名字", color: "#778899" });

    await vi.waitFor(() => {
      const peer = watcher.getPeers().find((candidate) => !candidate.local);
      expect(peer).toMatchObject({ name: "新名字", color: "#778899" });
    });
  });
});
