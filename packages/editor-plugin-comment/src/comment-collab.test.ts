// @vitest-environment jsdom
import { createEditor, type RichEditor } from "@kaelen/editor-api";
import {
  type CollabConnector,
  CollabRoom,
  type CollabRoomConnection,
  type CollabSocketHandlers,
  createCollabClient,
} from "@kaelen/editor-collab";
import type { SessionBridge, SessionExtension } from "@kaelen/editor-pm-adapter";
import type { EditorPlugin } from "@kaelen/editor-runtime";
import type { Annotation } from "@kaelen/editor-shared-types";
import { TextSelection } from "prosemirror-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCommentPlugin } from "./comment-plugin";

/** 一根内存里的网线，把 provider 接到房间上（与 S28 的会话测试同一套）。 */
function wire(room: CollabRoom): CollabConnector {
  let connection: CollabRoomConnection | undefined;
  let live = true;
  return (handlers: CollabSocketHandlers) => {
    live = true;
    connection = room.join({
      send: (message) => {
        if (live) {
          handlers.onMessage(message);
        }
      },
      close: () => {},
    });
    queueMicrotask(() => {
      if (live) {
        handlers.onOpen();
      }
    });
    return {
      send: (message) => {
        if (live) {
          connection?.receive(message);
        }
      },
      close: () => {
        live = false;
        connection?.leave();
        connection = undefined;
      },
    };
  };
}

function createProbe(): { plugin: EditorPlugin; bridge: () => SessionBridge } {
  let bridge: SessionBridge | undefined;
  const extension: SessionExtension = {
    plugins: () => [],
    bind: (session) => {
      bridge = session;
    },
    destroy: () => {
      bridge = undefined;
    },
  };
  return {
    plugin: {
      name: "probe",
      version: "0.0.1",
      namespace: "co_",
      createSessionExtensions: () => [extension],
    },
    bridge: () => {
      if (!bridge) {
        throw new Error("探针尚未绑定");
      }
      return bridge;
    },
  };
}

interface Peer {
  editor: RichEditor;
  bridge: () => SessionBridge;
  host: HTMLElement;
  destroy(): void;
}

const peers: Peer[] = [];
const rooms: CollabRoom[] = [];

function createRoom(): CollabRoom {
  const room = new CollabRoom("s29");
  rooms.push(room);
  return room;
}

/** 加入房间。`withComments` 为 false 时模拟没装评论插件的协作者。 */
function join(room: CollabRoom, name: string, withComments = true): Peer {
  const provider = createCollabClient({ connect: wire(room), peer: { name, color: "#3355ff" } });
  const probe = createProbe();
  const editor = createEditor({
    plugins: [...(withComments ? [createCommentPlugin()] : []), probe.plugin],
    collab: { provider },
  });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  const peer: Peer = {
    editor,
    bridge: probe.bridge,
    host,
    destroy: () => {
      editor.destroy();
      provider.destroy();
      host.remove();
    },
  };
  peers.push(peer);
  return peer;
}

async function bound(...list: Peer[]): Promise<void> {
  await vi.waitFor(() => {
    for (const peer of list) {
      expect(peer.editor.getCollabState().bound).toBe(true);
    }
  });
}

afterEach(() => {
  while (peers.length > 0) {
    peers.pop()?.destroy();
  }
  while (rooms.length > 0) {
    rooms.pop()?.destroy();
  }
});

function select(peer: Peer, from: number, to: number): void {
  const bridge = peer.bridge();
  const state = bridge.getState();
  bridge.dispatch(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
}

function insertText(peer: Peer, at: number, text: string): void {
  const bridge = peer.bridge();
  bridge.dispatch(bridge.getState().tr.insertText(text, at));
}

function deleteRange(peer: Peer, from: number, to: number): void {
  const bridge = peer.bridge();
  bridge.dispatch(bridge.getState().tr.delete(from, to));
}

const text = (peer: Peer): string =>
  peer.bridge().getState().doc.textBetween(0, peer.bridge().getState().doc.content.size, "\n");

function annotationText(peer: Peer, annotation: Annotation): string {
  return peer.bridge().getState().doc.textBetween(annotation.from, annotation.to, "\n");
}

describe("协同评论：批注存共享文档的批注表，锚点是 Y.RelativePosition", () => {
  it("一端加评论，另一端看到同一条批注，位置指向同一段文字", async () => {
    const room = createRoom();
    const left = join(room, "左");
    const right = join(room, "右");
    await bound(left, right);

    insertText(left, 1, "0123456789");
    await vi.waitFor(() => expect(text(right)).toBe("0123456789"));

    select(left, 3, 7);
    expect(left.editor.execute("comment.add", { id: "c1", payload: { text: "看这段" } }).ok).toBe(
      true,
    );
    expect(annotationText(left, left.editor.getAnnotations()[0] as Annotation)).toBe("2345");

    await vi.waitFor(() => {
      const remote = right.editor.getAnnotations();
      expect(remote).toHaveLength(1);
      expect(remote[0]).toMatchObject({ id: "c1", orphaned: false, payload: { text: "看这段" } });
      expect(annotationText(right, remote[0] as Annotation)).toBe("2345");
    });
  });

  it("远端在批注前插入文字，本端的高亮跟着走", async () => {
    const room = createRoom();
    const left = join(room, "左");
    const right = join(room, "右");
    await bound(left, right);

    insertText(left, 1, "0123456789");
    await vi.waitFor(() => expect(text(right)).toBe("0123456789"));
    select(left, 3, 7);
    left.editor.execute("comment.add", { id: "c1", payload: null });
    await vi.waitFor(() => expect(right.editor.getAnnotations()).toHaveLength(1));

    insertText(right, 1, "对方插在前面的");
    await vi.waitFor(() => {
      const annotation = left.editor.getAnnotations()[0] as Annotation;
      expect(annotation.orphaned).toBe(false);
      expect(annotationText(left, annotation)).toBe("2345");
    });
  });

  it("远端删掉锚定文字，本端批注置 orphaned 而不是消失", async () => {
    const room = createRoom();
    const left = join(room, "左");
    const right = join(room, "右");
    await bound(left, right);

    insertText(left, 1, "0123456789");
    await vi.waitFor(() => expect(text(right)).toBe("0123456789"));
    select(left, 3, 7);
    left.editor.execute("comment.add", { id: "c1", payload: { text: "别丢" } });
    await vi.waitFor(() => expect(right.editor.getAnnotations()).toHaveLength(1));

    deleteRange(right, 2, 8);
    await vi.waitFor(() => {
      const annotation = left.editor.getAnnotations()[0] as Annotation;
      expect(annotation.orphaned).toBe(true);
      expect(annotation.payload).toEqual({ text: "别丢" });
    });
  });

  it("一端删除评论，另一端同步消失", async () => {
    const room = createRoom();
    const left = join(room, "左");
    const right = join(room, "右");
    await bound(left, right);

    insertText(left, 1, "0123456789");
    select(left, 3, 7);
    left.editor.execute("comment.add", { id: "c1", payload: null });
    await vi.waitFor(() => expect(right.editor.getAnnotations()).toHaveLength(1));

    expect(right.editor.execute("comment.remove", { id: "c1" }).ok).toBe(true);
    await vi.waitFor(() => {
      expect(right.editor.getAnnotations()).toEqual([]);
      expect(left.editor.getAnnotations()).toEqual([]);
    });
  });

  it("本端编辑期间自己的批注实时映射，不用等一轮同步", async () => {
    const room = createRoom();
    const left = join(room, "左");
    await bound(left);

    insertText(left, 1, "0123456789");
    select(left, 3, 7);
    left.editor.execute("comment.add", { id: "c1", payload: null });

    insertText(left, 1, "本端立刻插入");
    const annotation = left.editor.getAnnotations()[0] as Annotation;
    expect(annotation.orphaned).toBe(false);
    expect(annotationText(left, annotation)).toBe("2345");
  });

  it("没装评论插件的协作者不被闸门拒绝，正文不丢，评论也不被它弄丢", async () => {
    const room = createRoom();
    const left = join(room, "左");
    const plain = join(room, "右", false);
    await bound(left, plain);

    insertText(left, 1, "0123456789");
    await vi.waitFor(() => expect(text(plain)).toBe("0123456789"));

    select(left, 3, 7);
    left.editor.execute("comment.add", { id: "c1", payload: { text: "它看不见我" } });

    // 评论更新到达没装插件的一端：不拒绝、不丢正文，只是看不见评论。
    await vi.waitFor(() => expect(text(plain)).toBe("0123456789"));
    expect(plain.editor.getCollabState().bound).toBe(true);
    expect(plain.editor.getCollabState().rejection).toBeUndefined();
    expect(plain.editor.getAnnotations()).toEqual([]);

    // 没装插件的一端继续编辑，评论在装了插件的两端照常存活并映射。
    insertText(plain, 1, "无插件端插入");
    await vi.waitFor(() => {
      const annotation = left.editor.getAnnotations()[0] as Annotation;
      expect(annotation.orphaned).toBe(false);
      expect(annotationText(left, annotation)).toBe("2345");
    });

    const late = join(room, "后来的");
    await bound(late);
    await vi.waitFor(() => {
      const annotation = late.editor.getAnnotations()[0] as Annotation;
      expect(annotation).toMatchObject({ id: "c1", orphaned: false });
      expect(annotationText(late, annotation)).toBe("2345");
    });
  });

  it("协同绑定后 getDocument() 的 annotations 是共享批注表的投影", async () => {
    const room = createRoom();
    const left = join(room, "左");
    const right = join(room, "右");
    await bound(left, right);

    insertText(left, 1, "0123456789");
    select(left, 3, 7);
    left.editor.execute("comment.add", { id: "c1", payload: { text: "投影" } });

    await vi.waitFor(() => {
      expect(right.editor.getDocument().annotations).toMatchObject([
        { id: "c1", orphaned: false, payload: { text: "投影" } },
      ]);
    });
  });
});
