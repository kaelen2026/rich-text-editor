// @vitest-environment jsdom
import { createEditor, type RichEditor } from "@kaelen/editor-api";
import {
  type CollabConnector,
  CollabRoom,
  type CollabRoomConnection,
  type CollabSocketHandlers,
  createCollabClient,
} from "@kaelen/editor-collab";
import {
  appendVersionLogEntry,
  createVersionLog,
  type SessionBridge,
  type SessionExtension,
  versionLogTip,
} from "@kaelen/editor-pm-adapter";
import type { EditorPlugin } from "@kaelen/editor-runtime";
import type { DocumentPatch, NodeJSON, VersionLog } from "@kaelen/editor-shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVersionHistoryPlugin } from "./version-history-plugin";

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
  editor: RichEditor;
  bridge: () => SessionBridge;
  log: () => VersionLog;
  destroy(): void;
}

const peers: Peer[] = [];
const rooms: CollabRoom[] = [];

function join(room: CollabRoom, name: string): Peer {
  let bridge: SessionBridge | undefined;
  const probe: SessionExtension = {
    plugins: () => [],
    bind: (session) => {
      bridge = session;
    },
    destroy: () => {
      bridge = undefined;
    },
  };
  const probePlugin: EditorPlugin = {
    name: "probe",
    version: "0.0.1",
    namespace: "co_",
    createSessionExtensions: () => [probe],
  };
  const provider = createCollabClient({ connect: wire(room), peer: { name, color: "#3355ff" } });
  const editor = createEditor({
    plugins: [createVersionHistoryPlugin(), probePlugin],
    collab: { provider },
  });
  const host = document.createElement("div");
  document.body.append(host);
  editor.mount(host);
  // 本端视角的版本日志：patch 流对远端事务同样产出（整篇 replace），
  // 因此日志的末尾始终就是本端当前文档。
  let log = createVersionLog(JSON.parse(JSON.stringify(editor.getDocument().doc)) as NodeJSON, 0);
  editor.subscribe("patch", (patch: DocumentPatch) => {
    const appended = appendVersionLogEntry(log, patch);
    if (appended.ok) {
      log = appended.log;
    }
  });
  const peer: Peer = {
    editor,
    bridge: () => {
      if (!bridge) {
        throw new Error("探针尚未绑定");
      }
      return bridge;
    },
    log: () => log,
    destroy: () => {
      editor.destroy();
      provider.destroy();
      host.remove();
    },
  };
  peers.push(peer);
  return peer;
}

afterEach(() => {
  while (peers.length > 0) {
    peers.pop()?.destroy();
  }
  while (rooms.length > 0) {
    rooms.pop()?.destroy();
  }
});

const text = (peer: Peer): string => {
  const state = peer.bridge().getState();
  return state.doc.textBetween(0, state.doc.content.size, "\n");
};

function insertText(peer: Peer, at: number, value: string): void {
  const bridge = peer.bridge();
  bridge.dispatch(bridge.getState().tr.insertText(value, at));
}

describe("协同下的版本恢复", () => {
  it("恢复是普通的一笔编辑：两端收敛到目标版本，随后还能继续编辑", async () => {
    const room = new CollabRoom("s30");
    rooms.push(room);
    const left = join(room, "左");
    const right = join(room, "右");
    await vi.waitFor(() => {
      expect(left.editor.getCollabState().bound).toBe(true);
      expect(right.editor.getCollabState().bound).toBe(true);
    });

    insertText(left, 1, "基线");
    await vi.waitFor(() => expect(text(right)).toBe("基线"));
    const targetRevision = versionLogTip(left.log());
    const targetText = text(left);

    insertText(right, 1, "对方的编辑");
    await vi.waitFor(() => expect(text(left)).toBe("对方的编辑基线"));
    insertText(left, 1, "本端的编辑");
    await vi.waitFor(() => expect(text(right)).toBe("本端的编辑对方的编辑基线"));

    // 左端恢复到"基线"版本。远端的编辑也在它的日志里（整篇 replace patch），
    // 因此恢复会把它们一并改回去——这是一次普通编辑，不是回退谁的历史。
    expect(
      left.editor.execute("version.restore", {
        history: left.log(),
        revision: targetRevision,
      }).ok,
    ).toBe(true);
    expect(text(left)).toBe(targetText);
    await vi.waitFor(() => expect(text(right)).toBe(targetText));

    // 恢复之后两端都还能正常编辑并继续收敛。
    insertText(right, 1, "恢复后再写");
    await vi.waitFor(() => expect(text(left)).toBe(`恢复后再写${targetText}`));
  });
});
