// @vitest-environment jsdom

import type { Node as ProseMirrorNode } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView, type NodeView } from "prosemirror-view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prosemirrorJSONToYXmlFragment, ySyncPlugin } from "y-prosemirror";
import * as Y from "yjs";
import { buildSchema } from "./schema";

const schema = buildSchema({
  nodes: {
    co_table: {
      content: "co_table_row+",
      group: "block",
      toDOM: () => ["table", ["tbody", 0]],
    },
    co_table_row: {
      content: "co_table_cell+",
      toDOM: () => ["tr", 0],
    },
    co_table_cell: {
      content: "block+",
      toDOM: () => ["td", 0],
    },
    co_widget: {
      inline: true,
      group: "inline",
      atom: true,
      attrs: { label: { default: "widget" } },
      toDOM: (node) => ["span", { "data-widget": String(node.attrs.label) }],
    },
  },
});

const initialDoc = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Introduction" }] },
    {
      type: "co_table",
      content: [
        {
          type: "co_table_row",
          content: [
            {
              type: "co_table_cell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "A1" }] }],
            },
            {
              type: "co_table_cell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "B1" }] }],
            },
          ],
        },
      ],
    },
    {
      type: "paragraph",
      content: [
        { type: "text", text: "before " },
        { type: "co_widget", attrs: { label: "initial" } },
        { type: "text", text: " after" },
      ],
    },
  ],
};

const views: EditorView[] = [];

afterEach(() => {
  while (views.length > 0) {
    views.pop()?.destroy();
  }
});

describe("y-prosemirror compatibility PoC", () => {
  it("同步表格结构，并把远端属性变更交给自定义 NodeView 更新", async () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment("prosemirror");
    prosemirrorJSONToYXmlFragment(schema, initialDoc, fragment);
    const source = createView(fragment);
    const nodeViewUpdate = vi.fn((node) => node.type.name === "co_widget");
    const target = createView(fragment, nodeViewUpdate);

    await vi.waitFor(() => {
      expect(target.state.doc.toJSON()).toEqual(initialDoc);
    });

    const tableCellTextPosition = findTextPosition(source, "A1");
    source.dispatch(source.state.tr.insertText(" shared", tableCellTextPosition + 2));

    await vi.waitFor(() => {
      expect(target.state.doc.child(1).toJSON()).toEqual({
        type: "co_table",
        content: [
          {
            type: "co_table_row",
            content: [
              {
                type: "co_table_cell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "A1 shared" }] }],
              },
              {
                type: "co_table_cell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "B1" }] }],
              },
            ],
          },
        ],
      });
    });

    const widgetPosition = findNodePosition(source, "co_widget");
    source.dispatch(source.state.tr.setNodeMarkup(widgetPosition, undefined, { label: "remote" }));

    await vi.waitFor(() => {
      expect(target.dom.querySelector("[data-widget]")?.getAttribute("data-widget")).toBe("remote");
      expect(nodeViewUpdate).toHaveBeenCalled();
    });
  });
});

function createView(
  fragment: Y.XmlFragment,
  onNodeViewUpdate: (node: ProseMirrorNode) => boolean = () => true,
): EditorView {
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView(host, {
    state: EditorState.create({
      schema,
      plugins: [ySyncPlugin(fragment)],
    }),
    nodeViews: {
      co_widget: (node) => widgetNodeView(node, onNodeViewUpdate),
    },
  });
  views.push(view);
  return view;
}

function widgetNodeView(
  node: ProseMirrorNode,
  onUpdate: (node: ProseMirrorNode) => boolean,
): NodeView {
  const dom = document.createElement("span");
  const render = (nextNode: typeof node) => {
    dom.dataset.widget = String(nextNode.attrs.label);
  };
  render(node);
  return {
    dom,
    update(nextNode) {
      render(nextNode);
      return onUpdate(nextNode);
    },
  };
}

function findTextPosition(view: EditorView, text: string): number {
  let position = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === text) {
      position = pos;
      return false;
    }
    return true;
  });
  if (position < 0) {
    throw new Error(`未找到文本：${text}`);
  }
  return position;
}

function findNodePosition(view: EditorView, nodeName: string): number {
  let position = -1;
  view.state.doc.descendants((node, pos) => {
    if (node.type.name === nodeName) {
      position = pos;
      return false;
    }
    return true;
  });
  if (position < 0) {
    throw new Error(`未找到节点：${nodeName}`);
  }
  return position;
}
