import { createEditor } from "@kaelen/editor-api";
import { buildSchema, parseExternalHTML } from "@kaelen/editor-pm-adapter";
import { resolvePlugins } from "@kaelen/editor-runtime";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createTablePlugin } from "./table-plugin";

describe("表格插件", () => {
  it("注册带 co_ 名称的表格结构，并完整保留合并单元格属性", () => {
    const editor = createEditor({ plugins: [createTablePlugin()] });
    const result = editor.loadDocument({
      envelope: 1,
      schemaVersion: 1,
      plugins: { table: 1 },
      annotations: [],
      doc: {
        type: "doc",
        content: [
          {
            type: "co_table",
            content: [
              {
                type: "co_table_row",
                content: [
                  {
                    type: "co_table_header",
                    attrs: { colspan: 2, rowspan: 1, colwidth: null },
                    content: [
                      {
                        type: "paragraph",
                        attrs: { align: null },
                        content: [{ type: "text", text: "表头" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(result).toMatchObject({ ok: true, degraded: false });
    expect(editor.getDocument().doc.content?.[0]).toMatchObject({
      type: "co_table",
      content: [
        {
          type: "co_table_row",
          content: [
            {
              type: "co_table_header",
              attrs: { colspan: 2, rowspan: 1, colwidth: null },
            },
          ],
        },
      ],
    });
  });

  it("插入表格受 5000 单元格上限约束，且可撤销", () => {
    const editor = createEditor({ plugins: [createTablePlugin()] });
    const patches: unknown[] = [];
    editor.subscribe("patch", (patch) => patches.push(patch));
    editor.loadDocument({
      type: "doc",
      content: [
        { type: "paragraph", attrs: { align: null }, content: [{ type: "text", text: "插入点" }] },
      ],
    });

    expect(editor.execute("table.insert", { rows: 2, cols: 3, withHeaderRow: true })).toEqual({
      ok: true,
    });
    const table = editor.getDocument().doc.content?.[0];
    expect(table?.type).toBe("co_table");
    expect(table?.content).toHaveLength(2);
    expect(table?.content?.[0]?.content).toHaveLength(3);
    expect(table?.content?.[0]?.content?.every((cell) => cell.type === "co_table_header")).toBe(
      true,
    );
    expect(table?.content?.[1]?.content?.every((cell) => cell.type === "co_table_cell")).toBe(true);
    expect(patches).toHaveLength(1);

    expect(editor.execute("table.addRowAfter")).toEqual({ ok: true });
    expect(editor.execute("table.addColumnAfter")).toEqual({ ok: true });
    const expanded = editor.getDocument().doc.content?.[0];
    expect(expanded?.content).toHaveLength(3);
    expect(expanded?.content?.every((row) => row.content?.length === 4)).toBe(true);

    expect(editor.undo()).toEqual({ ok: true });
    expect(editor.getDocument().doc.content?.[0]).toMatchObject({ type: "co_table" });
    expect(editor.undo()).toEqual({ ok: true });
    expect(editor.getDocument().doc.content?.[0]).toMatchObject({ type: "paragraph" });
    expect(editor.execute("table.insert", { rows: 100, cols: 51 })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("将外部 table 安全映射为表格节点，并规范化合并单元格属性", () => {
    const resolution = resolvePlugins([createTablePlugin()]);
    const schema = buildSchema({ nodes: resolution.nodes, marks: resolution.marks });
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    const oldDOMParser = globalThis.DOMParser;
    globalThis.DOMParser = dom.window.DOMParser;

    try {
      expect(
        parseExternalHTML(
          schema,
          '<table><tbody><tr><th colspan="2">表头</th><td rowspan="9999">内容<script>忽略</script></td></tr></tbody></table>',
        ).content.toJSON(),
      ).toEqual([
        {
          type: "co_table",
          content: [
            {
              type: "co_table_row",
              content: [
                {
                  type: "co_table_header",
                  attrs: { colspan: 2, rowspan: 1, colwidth: null },
                  content: [
                    {
                      type: "paragraph",
                      attrs: { align: null },
                      content: [{ type: "text", text: "表头" }],
                    },
                  ],
                },
                {
                  type: "co_table_cell",
                  attrs: { colspan: 1, rowspan: 1000, colwidth: null },
                  content: [
                    {
                      type: "paragraph",
                      attrs: { align: null },
                      content: [{ type: "text", text: "内容" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ]);
    } finally {
      globalThis.DOMParser = oldDOMParser;
      dom.window.close();
    }
  });

  it("缺少表格插件时降级保留，重新安装后可恢复编辑", () => {
    const author = createEditor({ plugins: [createTablePlugin()] });
    author.execute("table.insert", { rows: 1, cols: 1, withHeaderRow: false });

    const withoutTable = createEditor();
    expect(withoutTable.loadDocument(author.getDocument())).toMatchObject({
      ok: true,
      degraded: true,
      unknownNodes: ["co_table"],
    });

    const restored = createEditor({ plugins: [createTablePlugin()] });
    expect(restored.loadDocument(withoutTable.getDocument())).toMatchObject({
      ok: true,
      degraded: false,
    });
    expect(restored.getDocument().doc.content?.[0]).toMatchObject({ type: "co_table" });
  });
});
