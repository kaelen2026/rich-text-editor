#!/usr/bin/env node
/**
 * 包间依赖方向检查（方案 §7.1、§16.5）。
 *
 * 分层不是画在文档里就成立的：只要有人在 `editor-schema` 里 import 一次 React，
 * 服务端渲染那条路就断了，而 `tsc` 和测试都不会有任何反应——本地 pnpm 把依赖提
 * 上来了，代码照跑。这份检查把方向写成可执行的规则。
 *
 * 查三件事：
 *
 * 1. **声明的工作区依赖是否越层**。每个包只允许依赖它下面那一层。
 * 2. **import 的工作区包是否都声明了**。用得上却没写进 package.json 的依赖靠
 *    pnpm 的提升侥幸能跑，单独发布就断——这类"幽灵依赖"要在这里拦住。
 * 3. **是否引入了这一层不该有的外部依赖**。核心包不许碰 React/Vue；
 *    `editor-shared-types` 零依赖；`editor-schema` 连 ProseMirror 都不能碰。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import ts from "typescript";

const SCOPE = "@kaelen/";

/** 框架 UI 只在适配层出现；核心包一律不许。 */
const FRAMEWORK = ["react", "react-dom", "vue"];

/** 唯一允许出现框架的四个包。它们的职责就是挂载与渲染（§7.1）。 */
const FRAMEWORK_LAYER = new Set(["editor-react", "editor-react-ui", "editor-vue", "editor-vue-ui"]);

/**
 * 每个包允许直接依赖的工作区包。空数组是"不许依赖任何工作区包"。
 *
 * 名字用不带 scope 的短名。`apps/` 下的应用是消费方，不受约束。
 */
const ALLOWED = {
  "editor-shared-types": [],
  "editor-remote-image-service": [],
  "editor-schema": ["editor-shared-types"],
  "editor-ui-model": ["editor-shared-types"],
  "editor-pm-adapter": ["editor-schema", "editor-shared-types"],
  "editor-runtime": ["editor-pm-adapter", "editor-schema", "editor-shared-types"],
  "editor-api": ["editor-runtime", "editor-schema", "editor-shared-types"],
  "editor-markdown": ["editor-schema", "editor-shared-types"],
  "editor-react": ["editor-api", "editor-shared-types"],
  "editor-vue": ["editor-api", "editor-shared-types"],
  "editor-react-ui": ["editor-react", "editor-ui-model", "editor-shared-types"],
  "editor-vue-ui": ["editor-vue", "editor-ui-model", "editor-shared-types"],
};

/** 能力插件共用一条规则：可以用运行时、Schema 与适配层，不许反过来被它们依赖。 */
const PLUGIN_ALLOWED = [
  "editor-pm-adapter",
  "editor-runtime",
  "editor-schema",
  "editor-shared-types",
];

/** 额外禁止的外部依赖。理由都写在 §7.1。 */
const FORBIDDEN_EXTERNAL = {
  "editor-shared-types": {
    match: () => true,
    reason: "共享协议包必须零依赖：它是所有层的公共下游",
  },
  "editor-schema": {
    match: (name) => name.startsWith("prosemirror-") || FRAMEWORK.includes(name),
    reason: "editor-schema 前后端共用，不依赖 ProseMirror、DOM 或任何框架",
  },
  "editor-ui-model": {
    match: (name) => FRAMEWORK.includes(name),
    reason: "工具栏行为是无框架的状态机，框架 UI 只决定外观",
  },
};

const errors = [];
const packages = collectPackages();

for (const pkg of packages) {
  const allowed = allowedFor(pkg.shortName);
  if (!allowed) {
    continue;
  }
  checkDeclaredDependencies(pkg, allowed);
  checkImports(pkg, allowed);
  checkForbiddenExternal(pkg);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`依赖方向检查通过：${packages.length} 个包`);
}

function allowedFor(shortName) {
  if (shortName.startsWith("editor-plugin-")) {
    return PLUGIN_ALLOWED;
  }
  return ALLOWED[shortName];
}

function collectPackages() {
  return readdirSync("packages")
    .map((name) => join("packages", name))
    .filter((dir) => statSync(dir).isDirectory())
    .map((dir) => {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return {
        dir,
        name: manifest.name,
        shortName: manifest.name.replace(SCOPE, ""),
        dependencies: Object.keys(manifest.dependencies ?? {}),
        devDependencies: Object.keys(manifest.devDependencies ?? {}),
      };
    });
}

function checkDeclaredDependencies(pkg, allowed) {
  for (const dependency of pkg.dependencies) {
    if (!dependency.startsWith(SCOPE)) {
      continue;
    }
    const short = dependency.replace(SCOPE, "");
    if (!allowed.includes(short)) {
      errors.push(
        `${pkg.dir}/package.json 依赖了 ${dependency}，越过了分层边界（${pkg.shortName} 只能依赖：${allowed.join("、") || "无"}）`,
      );
    }
  }
}

function checkImports(pkg, allowed) {
  for (const file of sourceFiles(join(pkg.dir, "src"))) {
    // 测试可以用上层包做集成验证（插件用 editor-api 装一个真编辑器），
    // 那不是产品代码的依赖方向，只要求它声明在 devDependencies 里。
    const isTest = /\.test\.tsx?$/.test(file);
    for (const specifier of importsOf(file)) {
      // 用自己的包名 import 自己是测试在走公开入口，不是依赖。
      if (!specifier.startsWith(SCOPE) || specifier === pkg.name) {
        continue;
      }
      const short = specifier.replace(SCOPE, "");
      const declared = isTest ? [...pkg.dependencies, ...pkg.devDependencies] : pkg.dependencies;
      if (!declared.includes(specifier)) {
        errors.push(
          `${file} import 了 ${specifier}，但 ${pkg.name} 没有声明它——靠 pnpm 提升能跑，单独发布就断`,
        );
      }
      if (!isTest && !allowed.includes(short)) {
        errors.push(`${file} import 了 ${specifier}，越过了分层边界`);
      }
    }
  }
}

function checkForbiddenExternal(pkg) {
  const rule = FORBIDDEN_EXTERNAL[pkg.shortName];
  // 框架 UI 是核心包的通用禁令，适配层四个包除外；包自己的额外规则叠在它上面。
  const forbidden = (name) => {
    if (name.startsWith(SCOPE)) {
      return false;
    }
    if (FRAMEWORK.includes(name)) {
      return !FRAMEWORK_LAYER.has(pkg.shortName);
    }
    return rule?.match(name) ?? false;
  };
  for (const dependency of pkg.dependencies) {
    if (forbidden(dependency)) {
      errors.push(
        `${pkg.dir}/package.json 依赖了 ${dependency}：${rule?.reason ?? "核心包不依赖框架 UI"}`,
      );
    }
  }
  for (const file of sourceFiles(join(pkg.dir, "src"))) {
    if (/\.test\.tsx?$/.test(file)) {
      continue;
    }
    for (const specifier of importsOf(file)) {
      // 只看包名，`react-dom/client` 一类的子路径也要算进去。
      const name = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : (specifier.split("/")[0] ?? specifier);
      if (specifier.startsWith(".") || specifier.startsWith("node:")) {
        continue;
      }
      if (forbidden(name)) {
        errors.push(`${file} import 了 ${specifier}：${rule?.reason ?? "核心包不依赖框架 UI"}`);
      }
    }
  }
}

function sourceFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return [".ts", ".tsx"].includes(extname(entry.name)) ? [path] : [];
  });
}

/** `preProcessFile` 认得静态 import、`import type`、`export from` 和动态 import。 */
function importsOf(file) {
  return ts
    .preProcessFile(readFileSync(file, "utf8"), true, true)
    .importedFiles.map((reference) => reference.fileName);
}
