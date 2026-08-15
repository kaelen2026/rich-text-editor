import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import type { NodeType, Node as ProseMirrorNode, Schema } from "prosemirror-model";
import { type Command, TextSelection } from "prosemirror-state";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  mergeCells,
  splitCell,
} from "prosemirror-tables";

export const TABLE_NODE = "co_table";
export const TABLE_ROW_NODE = "co_table_row";
export const TABLE_CELL_NODE = "co_table_cell";
export const TABLE_HEADER_NODE = "co_table_header";

/** 第一个表格插件：持久化节点名固定为 co_ 前缀，缺插件时由 S2 完整兜底。 */
export function createTablePlugin(): EditorPlugin {
  return {
    name: "table",
    version: "1.0.0",
    namespace: "co_",
    structureVersion: 1,
    extendSchema: (schema) => {
      schema.addNode(TABLE_NODE, {
        content: `${TABLE_ROW_NODE}+`,
        group: "block",
        isolating: true,
        tableRole: "table",
        parseDOM: [{ tag: "table" }],
        toDOM: () => ["table", ["tbody", 0]],
      });
      schema.addNode(TABLE_ROW_NODE, {
        content: `(${TABLE_CELL_NODE} | ${TABLE_HEADER_NODE})*`,
        tableRole: "row",
        parseDOM: [{ tag: "tr" }],
        toDOM: () => ["tr", 0],
      });
      for (const [name, tag, role] of [
        [TABLE_CELL_NODE, "td", "cell"],
        [TABLE_HEADER_NODE, "th", "header_cell"],
      ] as const) {
        schema.addNode(name, {
          content: "block+",
          isolating: true,
          tableRole: role,
          attrs: {
            colspan: { default: 1 },
            rowspan: { default: 1 },
            colwidth: { default: null },
          },
          parseDOM: [
            {
              tag,
              attrsFromDOM: {
                colspan: { attribute: "colspan", type: "integer", min: 1, max: 1000, default: 1 },
                rowspan: { attribute: "rowspan", type: "integer", min: 1, max: 1000, default: 1 },
              },
            },
          ],
          toDOM: (node) => [
            tag,
            {
              colspan: String(node.attrs.colspan),
              rowspan: String(node.attrs.rowspan),
            },
            0,
          ],
        });
      }
    },
    registerCommands: (commands) => {
      commands.add("table.insert", insertTableCommand);
      commands.add("table.addRowBefore", tableCommand(addRowBefore));
      commands.add("table.addRowAfter", tableCommand(addRowAfter));
      commands.add("table.addColumnBefore", tableCommand(addColumnBefore));
      commands.add("table.addColumnAfter", tableCommand(addColumnAfter));
      commands.add("table.deleteRow", tableCommand(deleteRow));
      commands.add("table.deleteColumn", tableCommand(deleteColumn));
      commands.add("table.delete", tableCommand(deleteTable));
      commands.add("table.mergeCells", tableCommand(mergeCells));
      commands.add("table.splitCell", tableCommand(splitCell));
    },
  };
}

const insertTableCommand: SessionCommand = {
  run(session, apply, input) {
    const dimensions = tableDimensions(input);
    if (!dimensions) {
      return {
        ok: false,
        reason: "invalid",
        detail: "表格行列必须为正整数，且单表不超过 5000 单元格",
      };
    }
    return session.applyCommand(insertTableCommandFor(dimensions), apply)
      ? { ok: true }
      : { ok: false, reason: "disabled" };
  },
  active: () => false,
};

function tableDimensions(
  input: unknown,
): { rows: number; cols: number; withHeaderRow: boolean } | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const { rows, cols, withHeaderRow = false } = input as Record<string, unknown>;
  if (
    !isPositiveInteger(rows) ||
    !isPositiveInteger(cols) ||
    rows * cols > 5000 ||
    typeof withHeaderRow !== "boolean"
  ) {
    return null;
  }
  return { rows, cols, withHeaderRow };
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function insertTableCommandFor(dimensions: {
  rows: number;
  cols: number;
  withHeaderRow: boolean;
}): Command {
  return (state, dispatch) => {
    const table = createTable(state.schema, dimensions);
    if (!table) {
      return false;
    }
    const transaction = state.tr.replaceSelectionWith(table);
    // 新表格落点进入首个单元格，使紧接着的表格菜单操作和 Tab 导航可用。
    let firstCellPos: number | undefined;
    transaction.doc.descendants((node, pos) => {
      if (
        node.type === state.schema.nodes[TABLE_CELL_NODE] ||
        node.type === state.schema.nodes[TABLE_HEADER_NODE]
      ) {
        firstCellPos ??= pos;
        return false;
      }
      return firstCellPos === undefined;
    });
    if (firstCellPos !== undefined) {
      transaction.setSelection(TextSelection.create(transaction.doc, firstCellPos + 2));
    }
    dispatch?.(transaction.scrollIntoView());
    return true;
  };
}

function tableCommand(command: Command): SessionCommand {
  return {
    run: (session, apply) =>
      session.applyCommand(command, apply) ? { ok: true } : { ok: false, reason: "disabled" },
    active: () => false,
  };
}

function createTable(
  schema: Schema,
  { rows, cols, withHeaderRow }: { rows: number; cols: number; withHeaderRow: boolean },
): ProseMirrorNode | null {
  const table = schema.nodes[TABLE_NODE];
  const row = schema.nodes[TABLE_ROW_NODE];
  const cell = schema.nodes[TABLE_CELL_NODE];
  const header = schema.nodes[TABLE_HEADER_NODE];
  if (!table || !row || !cell || !header) {
    return null;
  }
  const rowNodes = Array.from({ length: rows }, (_, rowIndex) =>
    row.createChecked(
      null,
      Array.from({ length: cols }, () =>
        createCell(rowIndex === 0 && withHeaderRow ? header : cell),
      ),
    ),
  );
  return table.createChecked(null, rowNodes);
}

function createCell(type: NodeType): ProseMirrorNode {
  const cell = type.createAndFill();
  if (!cell) {
    throw new Error(`无法创建 ${type.name} 的默认内容`);
  }
  return cell;
}
