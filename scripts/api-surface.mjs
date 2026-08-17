#!/usr/bin/env node
/**
 * 公开 API 表面快照（方案 §16.5）。
 *
 * 两个作用，第二个才是它必须进 CI 的理由：
 *
 * 1. 接口变更在 diff 里看得见。改一个字段的可选性、给回调多加一个参数，这些在
 *    实现里是一行，对接入方是破坏性变更——只有把表面写成文件才会有人过目。
 * 2. **ProseMirror 类型泄漏即失败。** §7.1 的分层收益是"业务侧接口治理"，判据就是
 *    业务拿不到 `EditorState` / `Transaction` / `Node` 这类可变内部对象。这条约束
 *    很容易被一次顺手的 re-export 破坏，而 `tsc` 只会觉得它类型正确。
 *
 * 只盯业务接入面。`editor-pm-adapter`、`editor-runtime` 和能力插件是桥接层，
 * §7.1 明确允许 ProseMirror 类型在那里流动，给它们做快照只会制造噪音。
 *
 * 已知的丑陋处：Vue 两个包的组件会打印出一长串 `DefineComponent<…>`。那是
 * `defineComponent` 推导出来的真实类型，不是这里的 bug；真正要看的 props 就在
 * 那串东西的第一个类型参数里。不去裁剪它——按形状裁剪等于给快照加一层会自己
 * 失效的启发式，而快照的全部价值在于它照实反映。
 *
 * 用法：`node scripts/api-surface.mjs`（校验）/ `--update`（重录）。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";

const PUBLIC_PACKAGES = [
  "editor-shared-types",
  "editor-schema",
  "editor-markdown",
  "editor-api",
  "editor-ui-model",
  "editor-react",
  "editor-react-ui",
  "editor-vue",
  "editor-vue-ui",
];

const SNAPSHOT_DIR = "api";
const update = process.argv.includes("--update");

/**
 * `--entry <file>` 只对给定入口跑泄漏检查、不比对快照。存在的理由是这份检查
 * 本身要能被测试：拿一个真的泄漏了的入口喂给它，看它是不是真的会失败。
 */
const entryFlag = process.argv.indexOf("--entry");
const singleEntry = entryFlag === -1 ? undefined : process.argv[entryFlag + 1];

const entries = singleEntry
  ? [{ name: singleEntry, entry: resolve(singleEntry), snapshot: false }]
  : PUBLIC_PACKAGES.map((name) => ({
      name,
      entry: resolve(join("packages", name, "src", "index.ts")),
      snapshot: true,
    }));

const program = ts.createProgram(
  entries.map((item) => item.entry),
  {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    jsx: ts.JsxEmit.ReactJSX,
  },
);
const checker = program.getTypeChecker();

const failures = [];
mkdirSync(SNAPSHOT_DIR, { recursive: true });

for (const { name, entry, snapshot } of entries) {
  const source = program.getSourceFile(entry);
  if (!source) {
    failures.push(`找不到入口文件：${entry}`);
    continue;
  }
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (!moduleSymbol) {
    failures.push(`${name} 的入口不是一个模块`);
    continue;
  }

  const lines = [`# ${name}`, ""];
  for (const symbol of sortedExports(moduleSymbol)) {
    const declaration = declarationOf(symbol);
    if (!declaration) {
      continue;
    }
    lines.push(...describe(symbol, declaration));
    reportProseMirrorLeak(name, symbol.getName(), declaration);
  }

  if (snapshot) {
    compareOrWrite(name, `${lines.join("\n").trimEnd()}\n`);
  }
}

// 同一个标识符会同时以 TypeReferenceNode 和 Identifier 命中，去重后再报。
const reported = [...new Set(failures)];
if (reported.length > 0) {
  console.error(reported.join("\n\n"));
  process.exitCode = 1;
} else {
  console.log(`API 表面检查通过：${entries.length} 个入口`);
}

function sortedExports(moduleSymbol) {
  return checker
    .getExportsOfModule(moduleSymbol)
    .slice()
    .sort((left, right) => left.getName().localeCompare(right.getName()));
}

/** re-export 的符号要先解引用，否则拿到的是 alias 而不是真正的声明。 */
function declarationOf(symbol) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  return resolved.declarations?.[0];
}

/**
 * 类型声明打印源文本——成员的增删改因此都落在 diff 里；值声明打印推导出的类型，
 * 那才是接入方真正看到的形状。
 */
function describe(symbol, declaration) {
  const name = symbol.getName();
  if (
    ts.isInterfaceDeclaration(declaration) ||
    ts.isTypeAliasDeclaration(declaration) ||
    ts.isEnumDeclaration(declaration) ||
    ts.isClassDeclaration(declaration)
  ) {
    return ["```ts", stripExportModifier(declaration.getText()), "```", ""];
  }
  const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
  const printed = checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation);
  return ["```ts", `${name}: ${normalizeModulePaths(printed)}`, "```", ""];
}

/**
 * 抹掉类型串里的绝对路径。
 *
 * `typeToString` 对无法在当前作用域内命名的类型会打印
 * `import("/绝对路径/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue")`。
 * 那串东西里有**仓库的绝对路径和依赖的具体版本号**，于是快照在本机和 CI 上必然不同、
 * 每次升级依赖也变——快照就成了永远对不上的东西。
 *
 * 这条是 CI 教的：第一版快照在本机全绿，推上去就炸，diff 里全是
 * `/Users/...` 对 `/home/runner/...`。
 */
function normalizeModulePaths(text) {
  return (
    text
      // pnpm 的虚拟目录：`.../node_modules/.pnpm/<包@版本>/node_modules/vue/dist/vue` → `vue/dist/vue`
      .replace(
        /import\("[^"]*\/node_modules\/\.pnpm\/[^/]+\/node_modules\/([^"]+)"\)/g,
        'import("$1")',
      )
      // 普通提升安装：`.../node_modules/react/index` → `react/index`
      .replace(/import\("[^"]*\/node_modules\/([^"]+)"\)/g, 'import("$1")')
      // 工作区内部文件：留下仓库相对路径
      .replaceAll(`${process.cwd()}/`, "")
  );
}

/** 快照里不带 `export`：它对每一条都一样，只会让 diff 更吵。 */
function stripExportModifier(text) {
  return text.replace(/^export\s+(declare\s+)?/, "");
}

/**
 * 直接命名 ProseMirror 类型即失败。判据是"声明来自哪个包"，不是名字长什么样——
 * 项目自己也有叫 `Plugin`、`Schema` 的类型，按名字匹配会误伤。
 *
 * 只查直接引用。`createLinkPlugin(): EditorPlugin` 里的 `EditorPlugin` 顺着展开
 * 也能摸到 ProseMirror，但那是 §7.1 允许的桥接层，不是泄漏到业务接口上。
 */
function reportProseMirrorLeak(packageName, exportName, declaration) {
  ts.forEachChild(declaration, function visit(node) {
    if (ts.isIdentifier(node) || ts.isTypeReferenceNode(node)) {
      const reference = ts.isTypeReferenceNode(node) ? node.typeName : node;
      const symbol = checker.getSymbolAtLocation(reference);
      const origin = symbol && originPackage(symbol);
      if (origin) {
        failures.push(
          `${packageName} 的公开导出 ${exportName} 直接暴露了 ProseMirror 类型 ` +
            `${reference.getText()}（来自 ${origin}）。\n` +
            "  §7.1：业务侧接口不出现 EditorState / Transaction / Node / PluginKey——" +
            "业务不能派发事务、不能持有可变内部状态。",
        );
      }
    }
    ts.forEachChild(node, visit);
  });
}

function originPackage(symbol) {
  const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  for (const declaration of resolved.declarations ?? []) {
    const file = declaration.getSourceFile().fileName;
    const match = /node_modules\/(prosemirror-[^/]+)\//.exec(file);
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

function compareOrWrite(name, content) {
  const path = join(SNAPSHOT_DIR, `${name}.api.md`);
  if (update) {
    writeFileSync(path, content);
    return;
  }
  let recorded;
  try {
    recorded = readFileSync(path, "utf8");
  } catch {
    failures.push(`缺少 API 快照 ${path}。确认变更后运行 pnpm api:update 重录。`);
    return;
  }
  if (recorded !== content) {
    failures.push(
      `${path} 与当前 API 表面不一致。\n${diff(recorded, content)}\n` +
        "  这是接入方看得见的变更。确认之后运行 pnpm api:update 重录，并在 PR 里说明。",
    );
  }
}

/** 只列出有出入的行，够定位就行——完整内容在快照文件里。 */
function diff(recorded, current) {
  const before = new Set(recorded.split("\n"));
  const after = new Set(current.split("\n"));
  const removed = [...before].filter((line) => line.trim() && !after.has(line));
  const added = [...after].filter((line) => line.trim() && !before.has(line));
  return [
    ...removed.slice(0, 20).map((line) => `  - ${line}`),
    ...added.slice(0, 20).map((line) => `  + ${line}`),
  ].join("\n");
}
