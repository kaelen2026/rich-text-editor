import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import { flattenTableCell } from "@kaelen/editor-schema";
import type { CoreNodeToMarkdown, NodeJSON } from "@kaelen/editor-shared-types";
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

/**
 * 表格 → GFM 表格。
 *
 * GFM 表格必须有表头行，而文档模型允许一张全是普通单元格的表；缺表头时补一行
 * 空表头，而不是把第一行数据顶上去当表头——那会让"表格有没有表头"这件事在一次
 * 导出后被改掉。
 *
 * `colspan` / `rowspan` 在 GFM 里没有写法，导出时按每个单元格各占一格摊平：
 * 文字一个不少，合并关系丢在导出结果里。存储格式仍是信封 JSON，合并信息在
 * 文档里原样保留（方案 §4.3）。
 */
const tableToMarkdown: CoreNodeToMarkdown = (node, context) => {
  const rows = layOutGrid(node.content, (cell) => flattenTableCell(context.block(cell)));
  const columns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (columns === 0) {
    return "";
  }
  // 全是普通单元格的表在 GFM 里没有写法（表头行是必需的），补一行空表头而不是
  // 把第一行数据顶上去——后者会在一次导出里把"这张表有没有表头"给改掉。
  const headerIsReal = (node.content[0]?.content ?? []).every(
    (cell) => cell.type === TABLE_HEADER_NODE,
  );
  const [header = [], ...body] = headerIsReal ? rows : [[], ...rows];
  const line = (cells: string[]): string =>
    `| ${Array.from({ length: columns }, (_unused, index) => cells[index] ?? "").join(" | ")} |`;

  return [line(header), `| ${Array(columns).fill("---").join(" | ")} |`, ...body.map(line)].join(
    "\n",
  );
};

/**
 * 把带 `colspan` / `rowspan` 的表摊平成规则网格。
 *
 * 合并关系在 GFM 里表达不了，但**列对不齐比丢掉合并线严重得多**：一个跨两列的
 * 表头如果只占一格，它后面每一列都会错位一格，整张表读出来的意思就变了。因此按
 * 占位网格排：被合并覆盖的格子留空，每个单元格的文字仍然出现在它自己那一格。
 */
function layOutGrid(
  rows: readonly NodeJSON[],
  render: (cell: NodeJSON) => string,
): Array<string[]> {
  const grid: Array<string[]> = [];
  const covered = new Set<string>();
  const span = (value: unknown): number =>
    typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 1;

  rows.forEach((row, rowIndex) => {
    grid[rowIndex] ??= [];
    let column = 0;
    for (const cell of row.content ?? []) {
      while (covered.has(`${rowIndex},${column}`)) {
        column += 1;
      }
      (grid[rowIndex] as string[])[column] = render(cell);
      const colspan = span(cell.attrs?.colspan);
      const rowspan = span(cell.attrs?.rowspan);
      for (let downward = 0; downward < rowspan; downward += 1) {
        for (let rightward = 0; rightward < colspan; rightward += 1) {
          if (downward !== 0 || rightward !== 0) {
            covered.add(`${rowIndex + downward},${column + rightward}`);
          }
        }
      }
      column += colspan;
    }
  });

  // 稀疏数组会让 `join` 输出空洞，统一补成空串。
  const width = grid.reduce((max, row) => Math.max(max, row.length), 0);
  return grid.map((row) => Array.from({ length: width }, (_unused, index) => row[index] ?? ""));
}

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
        toMarkdown: tableToMarkdown,
        fromMarkdown: [{ token: "table" }],
      });
      schema.addNode(TABLE_ROW_NODE, {
        content: `(${TABLE_CELL_NODE} | ${TABLE_HEADER_NODE})*`,
        tableRole: "row",
        parseDOM: [{ tag: "tr" }],
        toDOM: () => ["tr", 0],
        // 行的排版由表格统一负责——单元格宽度要看整张表才定得下来。
        fromMarkdown: [{ token: "tr" }],
      });
      for (const [name, tag, role, token] of [
        [TABLE_CELL_NODE, "td", "cell", "td"],
        [TABLE_HEADER_NODE, "th", "header_cell", "th"],
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
          // 单元格正文由表格摊平成单行；GFM 的单元格装不下块结构。
          toMarkdown: (node, context) => flattenTableCell(context.blocks(node.content)),
          fromMarkdown: [{ token }],
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
