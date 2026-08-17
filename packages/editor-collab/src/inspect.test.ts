import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { collectSharedNames, collectUpdateNames } from "./inspect";

/** 手搓共享片段，避免这份测试反过来依赖 y-prosemirror 的编码细节。 */
function fragmentWith(build: (fragment: Y.XmlFragment) => void): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment("prosemirror");
  build(fragment);
  return fragment;
}

describe("共享文档的名字扫描", () => {
  it("按出现顺序去重收集节点名", () => {
    const fragment = fragmentWith((root) => {
      const paragraph = new Y.XmlElement("paragraph");
      const table = new Y.XmlElement("co_table");
      const row = new Y.XmlElement("co_table_row");
      table.insert(0, [row]);
      root.insert(0, [paragraph, table, new Y.XmlElement("paragraph")]);
    });

    expect(collectSharedNames(fragment).nodes).toEqual(["paragraph", "co_table", "co_table_row"]);
  });

  it("收集嵌在文本 delta 属性里的标记名", () => {
    const fragment = fragmentWith((root) => {
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.applyDelta([
        { insert: "普通" },
        { insert: "加粗", attributes: { strong: {} } },
        { insert: "上色", attributes: { co_text_color: { value: "#ff0000" } } },
      ]);
      paragraph.insert(0, [text]);
      root.insert(0, [paragraph]);
    });

    expect(collectSharedNames(fragment).marks).toEqual(["strong", "co_text_color"]);
  });

  it("空片段没有任何名字", () => {
    expect(collectSharedNames(fragmentWith(() => {}))).toEqual({ nodes: [], marks: [] });
  });
});

describe("尚未应用的更新里的名字", () => {
  it("从更新字节里读出节点名与标记名，不必先应用它", () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment("prosemirror");
    const table = new Y.XmlElement("co_table");
    const text = new Y.XmlText();
    text.applyDelta([{ insert: "格子", attributes: { co_text_color: { value: "#ff0000" } } }]);
    table.insert(0, [text]);
    fragment.insert(0, [new Y.XmlElement("paragraph"), table]);

    const names = collectUpdateNames(Y.encodeStateAsUpdate(doc));

    expect(names.nodes).toEqual(["paragraph", "co_table"]);
    expect(names.marks).toEqual(["co_text_color"]);
  });

  it("只有文本的更新没有节点名", () => {
    const doc = new Y.Doc();
    doc.getText("body").insert(0, "纯文本");

    expect(collectUpdateNames(Y.encodeStateAsUpdate(doc))).toEqual({ nodes: [], marks: [] });
  });
});
