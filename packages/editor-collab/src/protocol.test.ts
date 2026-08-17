import { afterEach, describe, expect, it } from "vitest";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  applyMessage,
  type CollabEndpoint,
  encodeAwareness,
  encodeDocumentUpdate,
  encodeSyncStep1,
} from "./protocol";

const endpoints: CollabEndpoint[] = [];

function endpoint(): CollabEndpoint {
  const doc = new Y.Doc();
  const created = { doc, awareness: new Awareness(doc) };
  endpoints.push(created);
  return created;
}

afterEach(() => {
  while (endpoints.length > 0) {
    const created = endpoints.pop();
    created?.awareness.destroy();
    created?.doc.destroy();
  }
});

describe("协同线上协议", () => {
  it("syncStep1 换回对端的全部历史", () => {
    const source = endpoint();
    const target = endpoint();
    source.doc.getText("body").insert(0, "已有内容");

    const applied = applyMessage(encodeSyncStep1(target.doc), source, "target");
    expect(applied.reply).toBeDefined();
    expect(applied.documentApplied).toBe(false);

    const reply = applyMessage(applied.reply as Uint8Array, target, "source");
    expect(reply.documentApplied).toBe(true);
    expect(target.doc.getText("body").toString()).toBe("已有内容");
  });

  it("增量更新照原样搬过去", () => {
    const source = endpoint();
    const target = endpoint();
    let captured: Uint8Array | undefined;
    source.doc.on("update", (update: Uint8Array) => {
      captured = update;
    });

    source.doc.getText("body").insert(0, "增量");
    applyMessage(encodeDocumentUpdate(captured as Uint8Array), target, "source");

    expect(target.doc.getText("body").toString()).toBe("增量");
  });

  it("awareness 状态带着身份过去，且不动文档", () => {
    const source = endpoint();
    const target = endpoint();
    source.awareness.setLocalStateField("user", { name: "阿May", color: "#3355ff" });

    const applied = applyMessage(
      encodeAwareness(source.awareness, [source.doc.clientID]),
      target,
      "source",
    );

    expect(applied.documentApplied).toBe(false);
    expect(target.awareness.getStates().get(source.doc.clientID)).toEqual({
      user: { name: "阿May", color: "#3355ff" },
    });
  });

  it("远端更新带上 origin，不会被当成本地改动再广播一次", () => {
    const source = endpoint();
    const target = endpoint();
    const origins: unknown[] = [];
    target.doc.on("update", (_update: Uint8Array, origin: unknown) => {
      origins.push(origin);
    });

    let captured: Uint8Array | undefined;
    source.doc.on("update", (update: Uint8Array) => {
      captured = update;
    });
    source.doc.getText("body").insert(0, "远端");
    applyMessage(encodeDocumentUpdate(captured as Uint8Array), target, "wire");

    expect(origins).toEqual(["wire"]);
  });

  it("未知消息类型被忽略而不是断开", () => {
    const target = endpoint();
    // 信封的第一个字节是消息类型；99 是本协议还没定义的类型。
    expect(() => applyMessage(new Uint8Array([99, 0]), target, "source")).not.toThrow();
  });

  it("畸形的同步消息抛错，交给调用方决定怎么处置", () => {
    const target = endpoint();
    // 类型 0（sync）+ 未定义的同步子类型 9。
    expect(() => applyMessage(new Uint8Array([0, 9]), target, "source")).toThrow();
  });
});

describe("入站准入判断", () => {
  it("被拒的更新一字不落进文档", () => {
    const source = endpoint();
    const target = endpoint();
    const fragment = source.doc.getXmlFragment("prosemirror");
    fragment.insert(0, [new Y.XmlElement("co_table")]);

    const applied = applyMessage(
      encodeDocumentUpdate(Y.encodeStateAsUpdate(source.doc)),
      target,
      "source",
      { accept: (names) => !names.nodes.includes("co_table") },
    );

    expect(applied.documentApplied).toBe(false);
    expect(applied.rejected?.nodes).toEqual(["co_table"]);
    expect(target.doc.getXmlFragment("prosemirror").length).toBe(0);
  });

  it("认得的名字照常放行", () => {
    const source = endpoint();
    const target = endpoint();
    source.doc.getXmlFragment("prosemirror").insert(0, [new Y.XmlElement("paragraph")]);

    const applied = applyMessage(
      encodeDocumentUpdate(Y.encodeStateAsUpdate(source.doc)),
      target,
      "source",
      { accept: () => true },
    );

    expect(applied.documentApplied).toBe(true);
    expect(target.doc.getXmlFragment("prosemirror").length).toBe(1);
  });
});
