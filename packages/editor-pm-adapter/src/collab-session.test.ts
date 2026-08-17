// @vitest-environment jsdom

import {
  type CollabConnector,
  CollabRoom,
  type CollabRoomConnection,
  type CollabSocketHandlers,
  createCollabClient,
} from "@kaelen/editor-collab";
import type { CollabRejection, CollabState, NodeJSON } from "@kaelen/editor-shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CollabSessionOptions } from "./collab";
import { buildSchema } from "./schema";
import { EditorSession } from "./session";

/** 只有装了表格插件的一端才认识它。缺插件的那一端正是本文件要验的场景。 */
const tableSchema = buildSchema({
  nodes: {
    co_table: { content: "co_table_row+", group: "block", toDOM: () => ["table", ["tbody", 0]] },
    co_table_row: { content: "co_table_cell+", toDOM: () => ["tr", 0] },
    co_table_cell: { content: "block+", toDOM: () => ["td", 0] },
  },
});
const plainSchema = buildSchema();

const emptyDoc: NodeJSON = { type: "doc", content: [{ type: "paragraph" }] };

/** 一根内存里的网线，把 provider 接到房间上。 */
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

interface Peer {
  session: EditorSession;
  host: HTMLElement;
  collab: CollabSessionOptions;
  states: CollabState[];
  rejections: CollabRejection[];
}

const peers: Peer[] = [];
const rooms: CollabRoom[] = [];

function createRoom(): CollabRoom {
  const room = new CollabRoom("s28");
  rooms.push(room);
  return room;
}

function join(room: CollabRoom, schema = tableSchema, name = "协作者"): Peer {
  const provider = createCollabClient({ connect: wire(room), peer: { name, color: "#3355ff" } });
  const collab: CollabSessionOptions = { provider };
  const states: CollabState[] = [];
  const rejections: CollabRejection[] = [];
  const session = new EditorSession(
    schema,
    emptyDoc,
    () => {},
    "edit",
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    collab,
    (state) => states.push(state),
    (rejection) => rejections.push(rejection),
  );
  const host = document.createElement("div");
  document.body.append(host);
  session.mount(host);
  const peer: Peer = { session, host, collab, states, rejections };
  peers.push(peer);
  return peer;
}

function insertText(peer: Peer, text: string): void {
  peer.session.applyCommand((state, dispatch) => {
    dispatch?.(state.tr.insertText(text, 1));
    return true;
  }, true);
}

function insertTable(peer: Peer): void {
  peer.session.applySchemaCommand(
    (schema) => (state, dispatch) => {
      const cell = schema.nodes.co_table_cell?.createAndFill();
      const row = schema.nodes.co_table_row?.create(null, cell);
      const table = schema.nodes.co_table?.create(null, row);
      if (!table) {
        return false;
      }
      dispatch?.(state.tr.insert(state.doc.content.size, table));
      return true;
    },
    true,
  );
}

const text = (peer: Peer): string => peer.session.textContent;

afterEach(() => {
  while (peers.length > 0) {
    const peer = peers.pop();
    peer?.session.destroy();
    peer?.collab.provider.destroy();
    peer?.host.remove();
  }
  while (rooms.length > 0) {
    rooms.pop()?.destroy();
  }
});

describe("协同会话", () => {
  it("同步后才绑定共享文档，绑定前编辑的仍是本地文档", async () => {
    const room = createRoom();
    const peer = join(room);
    expect(peer.session.collabBound).toBe(false);

    await vi.waitFor(() => expect(peer.session.collabBound).toBe(true));
    expect(peer.session.collabState).toMatchObject({
      enabled: true,
      status: "synced",
      bound: true,
    });
  });

  it("两端并发编辑同一段落，内容汇合", async () => {
    const room = createRoom();
    const left = join(room, tableSchema, "左");
    const right = join(room, tableSchema, "右");
    await vi.waitFor(() => {
      expect(left.session.collabBound).toBe(true);
      expect(right.session.collabBound).toBe(true);
    });

    insertText(left, "左写的");
    await vi.waitFor(() => expect(text(right)).toBe("左写的"));

    insertText(right, "右写的");
    await vi.waitFor(() => {
      expect(text(left)).toBe(text(right));
      expect(text(left)).toContain("左写的");
      expect(text(left)).toContain("右写的");
    });
  });

  it("看得见对方：在线协作者带着名字与颜色", async () => {
    const room = createRoom();
    const left = join(room, tableSchema, "左");
    join(room, tableSchema, "右");

    await vi.waitFor(() => {
      expect(new Set(left.session.collabState.peers.map((peer) => peer.name))).toEqual(
        new Set(["左", "右"]),
      );
    });
    expect(left.session.collabState.peers.every((peer) => peer.color === "#3355ff")).toBe(true);
  });

  it("缺插件的一端被拒绝接入，共享文档一字未动", async () => {
    const room = createRoom();
    const owner = join(room, tableSchema, "有表格的人");
    await vi.waitFor(() => expect(owner.session.collabBound).toBe(true));
    insertTable(owner);
    await vi.waitFor(() =>
      expect(room.doc.getXmlFragment("prosemirror").toString()).toContain("co_table"),
    );
    const before = room.doc.getXmlFragment("prosemirror").toString();

    const stranger = join(room, plainSchema, "没装表格的人");

    await vi.waitFor(() => expect(stranger.rejections).toHaveLength(1));
    expect(stranger.rejections[0]).toMatchObject({
      code: "schema-incompatible",
      unknownNodes: ["co_table", "co_table_row", "co_table_cell"],
      unknownMarks: [],
    });
    expect(stranger.session.collabBound).toBe(false);
    // 这一条才是本片存在的理由：不兼容的一端接入过，而共享文档没有被它改坏。
    expect(room.doc.getXmlFragment("prosemirror").toString()).toBe(before);
    expect(owner.session.collabState.bound).toBe(true);
  });

  it("接入之后才出现的未知节点同样被挡下，并立刻退出协作", async () => {
    const room = createRoom();
    const owner = join(room, tableSchema, "有表格的人");
    const stranger = join(room, plainSchema, "没装表格的人");
    await vi.waitFor(() => {
      expect(owner.session.collabBound).toBe(true);
      expect(stranger.session.collabBound).toBe(true);
    });

    insertText(owner, "先来一段字");
    await vi.waitFor(() => expect(text(stranger)).toBe("先来一段字"));
    const before = room.doc.getXmlFragment("prosemirror").toString();

    insertTable(owner);

    await vi.waitFor(() => expect(stranger.rejections).toHaveLength(1));
    expect(stranger.session.collabBound).toBe(false);
    expect(stranger.session.collabState.rejection?.unknownNodes).toContain("co_table");
    // 退出协作的一端保留它最后看到的内容，不清空、也不回退。
    expect(text(stranger)).toBe("先来一段字");
    expect(room.doc.getXmlFragment("prosemirror").toString()).toContain(before);
  });

  it("撤销只回退自己的改动", async () => {
    const room = createRoom();
    const left = join(room, tableSchema, "左");
    const right = join(room, tableSchema, "右");
    await vi.waitFor(() => {
      expect(left.session.collabBound).toBe(true);
      expect(right.session.collabBound).toBe(true);
    });

    insertText(left, "左写的。");
    await vi.waitFor(() => expect(text(right)).toContain("左写的。"));
    insertText(right, "右写的。");
    await vi.waitFor(() => expect(text(left)).toContain("右写的。"));

    right.session.applyHistoryCommand("undo", true);

    await vi.waitFor(() => {
      expect(text(right)).not.toContain("右写的。");
      // 别人的改动必须留着：prosemirror-history 会把它一起退掉，那不是撤销。
      expect(text(right)).toContain("左写的。");
    });
  });

  it("试跑撤销只回答能不能，不真的撤销", async () => {
    const room = createRoom();
    const peer = join(room);
    await vi.waitFor(() => expect(peer.session.collabBound).toBe(true));
    insertText(peer, "写了一句。");
    await vi.waitFor(() => expect(text(peer)).toBe("写了一句。"));

    // 工具栏每渲染一帧都会这样问一次可用性。y-prosemirror 的 `undo` 无视
    // dispatch、一调用就真撤销，用错那一个等于每帧撤销一次。
    for (let i = 0; i < 5; i += 1) {
      expect(peer.session.applyHistoryCommand("undo", false)).toBe(true);
    }
    expect(text(peer)).toBe("写了一句。");

    expect(peer.session.applyHistoryCommand("undo", true)).toBe(true);
    await vi.waitFor(() => expect(text(peer)).toBe(""));
  });

  it("组合态期间远端改动不落地，组合结束后一次到位", async () => {
    const room = createRoom();
    const left = join(room, tableSchema, "左");
    const right = join(room, tableSchema, "右");
    await vi.waitFor(() => {
      expect(left.session.collabBound).toBe(true);
      expect(right.session.collabBound).toBe(true);
    });

    right.host
      .querySelector(".ProseMirror")
      ?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(right.session.composing).toBe(true);

    insertText(left, "远端在组合期间写的");
    await vi.waitFor(() =>
      expect(room.doc.getXmlFragment("prosemirror").toString()).toContain("远端在组合期间写的"),
    );
    expect(text(right)).toBe("");

    right.host
      .querySelector(".ProseMirror")
      ?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));

    await vi.waitFor(() => expect(text(right)).toBe("远端在组合期间写的"));
  });
});
