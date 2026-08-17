import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createEditor } from "@kaelen/editor-api";
import { createColorPlugin } from "@kaelen/editor-plugin-color";
import { createImagePlugin } from "@kaelen/editor-plugin-image";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { createTablePlugin } from "@kaelen/editor-plugin-table";
import { buildSchema, parseExternalHTML } from "@kaelen/editor-pm-adapter";
import { resolvePlugins } from "@kaelen/editor-runtime";
import type { EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";
import { type ToolbarDefinition, ToolbarModel } from "@kaelen/editor-ui-model";
import { JSDOM } from "jsdom";

export const PERFORMANCE_BASELINES = {
  initialEditableMs: 1_000,
  keypressToRedrawP95Ms: 200,
  paste10kTextMs: 1_000,
  toolbarStateUpdateMs: 80,
  wordCountMs: 80,
  memoryDeltaMb: 80,
} as const;

export type PerformanceMetric = keyof typeof PERFORMANCE_BASELINES;
export type PerformanceMeasurements = Record<PerformanceMetric, number>;
/** CI 允许相对记录基线最多 20% 的环境波动与性能回归。 */
export const PERFORMANCE_BUDGETS: PerformanceMeasurements = Object.fromEntries(
  Object.entries(PERFORMANCE_BASELINES).map(([metric, baseline]) => [metric, baseline * 1.2]),
) as PerformanceMeasurements;

export interface BenchmarkDocumentStats {
  textCharacters: number;
  paragraphs: number;
  images: number;
  tables: number;
  listDepth: number;
}

export interface BudgetFailure {
  metric: PerformanceMetric;
  measured: number;
  budget: number;
}

const benchmarkPlugins = [
  createLinkPlugin(),
  createTablePlugin(),
  createColorPlugin(),
  createImagePlugin({
    uploader: {
      upload: async () => ({ url: "https://assets.example.invalid/benchmark.png" }),
    },
  }),
];

/**
 * 固定负载让基准可以在 CI 对照：5 万字、300 段、50 图、20 表与 4 层列表。
 * 表格、图片与列表的空块不计入 5 万字，避免把结构负载和文本负载混为一个变量。
 */
export function createBenchmarkDocument(): EditorEnvelope {
  let remainingCharacters = 50_000;
  const paragraphs = Array.from({ length: 300 }, (_, index) => {
    const characters = Math.ceil(remainingCharacters / (300 - index));
    remainingCharacters -= characters;
    return paragraph("字".repeat(characters));
  });

  return {
    envelope: 1,
    schemaVersion: 1,
    plugins: { image: 1, link: 1, table: 1 },
    doc: {
      type: "doc",
      content: [
        ...paragraphs,
        ...Array.from({ length: 50 }, (_, index) => image(index)),
        ...Array.from({ length: 20 }, () => table()),
        nestedList(1),
      ],
    },
    annotations: [],
  };
}

export function getBenchmarkDocumentStats(envelope: EditorEnvelope): BenchmarkDocumentStats {
  let textCharacters = 0;
  let images = 0;
  let tables = 0;
  let listDepth = 0;
  const visit = (node: NodeJSON, depth: number): void => {
    textCharacters += Array.from(node.text ?? "").length;
    if (node.type === "co_image") {
      images += 1;
    }
    if (node.type === "co_table") {
      tables += 1;
    }
    const nextDepth = node.type === "bullet_list" ? depth + 1 : depth;
    listDepth = Math.max(listDepth, nextDepth);
    for (const child of node.content ?? []) {
      visit(child, nextDepth);
    }
  };
  visit(envelope.doc, 0);
  return {
    textCharacters,
    paragraphs: envelope.doc.content?.filter((node) => node.type === "paragraph").length ?? 0,
    images,
    tables,
    listDepth,
  };
}

/** Returns every metric over its recorded CI budget. */
export function compareMeasurements(measurements: PerformanceMeasurements): BudgetFailure[] {
  return (Object.keys(PERFORMANCE_BUDGETS) as PerformanceMetric[]).flatMap((metric) => {
    const measured = measurements[metric];
    const budget = PERFORMANCE_BUDGETS[metric];
    return measured > budget ? [{ metric, measured, budget }] : [];
  });
}

export function runBenchmarks(): PerformanceMeasurements {
  const document = createBenchmarkDocument();
  const schema = benchmarkSchema();
  return {
    initialEditableMs: withBrowserDOM((host) =>
      measure(() => {
        const editor = createBenchmarkEditor();
        editor.loadDocument(document);
        editor.mount(host);
        editor.getSnapshot();
        editor.destroy();
      }),
    ),
    keypressToRedrawP95Ms: withBrowserDOM((host) =>
      percentile95(
        Array.from({ length: 20 }, () => {
          const editor = createBenchmarkEditor();
          editor.loadDocument(document);
          editor.mount(host);
          editor.execute("selection.selectAll");
          const elapsed = measure(() => {
            editor.execute("format.bold");
            // EditorView 同步更新 DOM；读取文本保证该路径被实际走到。
            host.textContent;
          });
          editor.destroy();
          return elapsed;
        }),
      ),
    ),
    paste10kTextMs: withBrowserDOM(() =>
      measure(() => {
        const slice = parseExternalHTML(schema, `<p>${"粘贴".repeat(5_000)}</p>`);
        if (slice.content.size === 0) {
          throw new Error("10k 文本粘贴基准未产生内容");
        }
      }),
    ),
    toolbarStateUpdateMs: measure(() => {
      const editor = createBenchmarkEditor();
      editor.loadDocument(document);
      editor.execute("selection.selectAll");
      new ToolbarModel(toolbarDefinition, editor.queryCommand).snapshot;
    }),
    // 字数当前是全量重算 + 按变更缓存，因此测的就是"内容变更后第一次读取"的代价。
    wordCountMs: (() => {
      const editor = createBenchmarkEditor();
      editor.loadDocument(document);
      return measure(() => {
        if (editor.getTextStats().characters === 0) {
          throw new Error("字数统计基准未数到字符");
        }
      });
    })(),
    memoryDeltaMb: memoryDelta(() => {
      const editor = createBenchmarkEditor();
      editor.loadDocument(document);
      editor.getDocument();
      editor.getHTML();
    }),
  };
}

function createBenchmarkEditor() {
  return createEditor({ plugins: benchmarkPlugins });
}

function benchmarkSchema() {
  const resolution = resolvePlugins(benchmarkPlugins);
  return buildSchema({ nodes: resolution.nodes, marks: resolution.marks });
}

function paragraph(text = ""): NodeJSON {
  return text ? { type: "paragraph", content: [{ type: "text", text }] } : { type: "paragraph" };
}

function image(index: number): NodeJSON {
  return {
    type: "co_image",
    attrs: {
      src: `https://assets.example.invalid/${index}.png`,
      alt: `基准图片 ${index + 1}`,
      width: null,
      height: null,
    },
  };
}

function table(): NodeJSON {
  return {
    type: "co_table",
    content: Array.from({ length: 3 }, () => ({
      type: "co_table_row",
      content: Array.from({ length: 3 }, () => ({
        type: "co_table_cell",
        attrs: { colspan: 1, rowspan: 1, colwidth: null },
        content: [paragraph()],
      })),
    })),
  };
}

function nestedList(depth: number): NodeJSON {
  return {
    type: "bullet_list",
    content: [
      {
        type: "list_item",
        content: [paragraph(), ...(depth < 4 ? [nestedList(depth + 1)] : [])],
      },
    ],
  };
}

function measure(run: () => void): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

function percentile95(samples: number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function memoryDelta(run: () => void): number {
  const before = process.memoryUsage().heapUsed;
  run();
  const after = process.memoryUsage().heapUsed;
  return Math.max(0, after - before) / 1024 / 1024;
}

function withBrowserDOM<T>(run: (host: HTMLElement) => T): T {
  const previous = globalThis.DOMParser;
  const previousDocument = globalThis.document;
  const previousHTMLElement = globalThis.HTMLElement;
  const previousNode = globalThis.Node;
  const previousWindow = globalThis.window;
  const window = new JSDOM("<!doctype html><html><body><div id=host></div></body></html>").window;
  const host = window.document.getElementById("host");
  if (!host) {
    throw new Error("性能基准的编辑器挂载点缺失");
  }
  Object.assign(globalThis, {
    DOMParser: window.DOMParser,
    document: window.document,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    window,
  });
  try {
    return run(host);
  } finally {
    Object.assign(globalThis, {
      DOMParser: previous,
      document: previousDocument,
      HTMLElement: previousHTMLElement,
      Node: previousNode,
      window: previousWindow,
    });
    window.close();
  }
}

const toolbarDefinition: ToolbarDefinition = {
  label: "性能基准工具栏",
  groups: [
    {
      label: "格式",
      items: [
        { id: "bold", label: "加粗", command: "format.bold" },
        { id: "heading", label: "二级标题", command: "block.setHeading", input: 2 },
        { id: "link", label: "链接", command: "link.set", input: { href: "https://example.com" } },
      ],
    },
    {
      label: "插入",
      items: [
        {
          id: "table",
          label: "表格",
          command: "table.insert",
          input: { rows: 3, cols: 3, withHeaderRow: false },
        },
      ],
    },
  ],
};

/**
 * 一次基准运行的完整记录。
 *
 * 阈值校准（方案 §14）要的是"同一环境下连续多次的真实分布"，而不是某一次的
 * 数字，因此环境信息必须和测量值一起记下来：本机跑出来的结果和 CI runner 上
 * 跑出来的不可比，混在一起算出的阈值只会同时冤枉一边。
 */
export interface BenchmarkRun {
  recordedAt: string;
  node: string;
  platform: string;
  /** CI runner 的标识；本地运行为 `local`。校准脚本按它分组。 */
  environment: string;
  measurements: PerformanceMeasurements;
  budgets: PerformanceMeasurements;
}

export function toBenchmarkRun(measurements: PerformanceMeasurements, now: Date): BenchmarkRun {
  return {
    recordedAt: now.toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    environment: process.env.RUNNER_NAME ?? (process.env.CI ? "ci" : "local"),
    measurements,
    budgets: PERFORMANCE_BUDGETS,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const measurements = runBenchmarks();
  const failures = compareMeasurements(measurements);
  console.table(
    Object.entries(measurements).map(([metric, measured]) => ({
      metric,
      measured: measured.toFixed(2),
      budget: PERFORMANCE_BUDGETS[metric as PerformanceMetric],
    })),
  );
  // `--json <path>` 把这一次的结果连同环境一起写出来。CI 按运行归档，攒够样本
  // 之后交给 scripts/calibrate-budgets.mjs 反推阈值。
  const jsonFlag = process.argv.indexOf("--json");
  if (jsonFlag !== -1) {
    const target = process.argv[jsonFlag + 1];
    if (!target) {
      throw new Error("用法：pnpm bench --json <output.json>");
    }
    writeFileSync(target, `${JSON.stringify(toBenchmarkRun(measurements, new Date()), null, 2)}\n`);
    console.log(`已写出基准记录：${target}`);
  }
  if (failures.length > 0) {
    console.error("性能预算超限（预算已含 20% CI 回归余量）：");
    for (const failure of failures) {
      console.error(
        `- ${failure.metric}: ${failure.measured.toFixed(2)} > ${failure.budget.toFixed(2)}`,
      );
    }
    process.exitCode = 1;
  }
}
