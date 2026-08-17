# rich-text-editor

一个基于 ProseMirror 的结构化富文本编辑器平台：内核不依赖框架，能力以插件形式挂载，React 与 Vue 各有一层薄适配。文档以**版本化信封 JSON** 为唯一事实来源，HTML / 纯文本只是交换格式。

这个仓库是 pnpm monorepo。所有包目前都是 `private: true` 的 workspace 内部包，**尚未发布到 registry**；接入方式是在同一个 workspace 里用 `workspace:*` 依赖。

## 它已经能做什么

段落与 h1–h4 标题、引用、分隔线、代码块、无序/有序/待办列表、粗体斜体下划线删除线行内代码、链接、表格（含合并单元格与键盘导航）、图片（上传、拖入、粘贴，以及尺寸/裁剪/旋转/滤镜/环绕的非破坏性二次编辑）、文字与背景颜色、块级水平对齐。

复制粘贴覆盖编辑器内部（保开合深度的 Slice）、外部网页 HTML、Word、Excel 与纯文本，全部经 Schema 白名单与 inert 解析。远端图片一律服务端转存，带完整 SSRF 控制。

底层原语已经就位但尚未做成功能：`DocumentPatch` 增量变更流、位置映射契约、信封 `annotations` 评论锚点字段。协同、评论、版本历史、AI 属于 M4，本仓库暂不覆盖。

当前进度与逐片交付状态见 [`docs/implementation-slices.md`](docs/implementation-slices.md)。

## 快速开始

需要 Node.js 22+ 与 pnpm（仓库用 Corepack 锁定版本）。

```sh
pnpm install
pnpm dev          # 打开 playground，每一片能力的演示场地
```

提 PR 前跑这三条：

```sh
pnpm check        # Biome lint/format + toDOM 不碰 document 的静态检查
pnpm typecheck
pnpm test
```

### 全部脚本

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 启动 playground（`apps/playground`） |
| `pnpm check` / `pnpm check:fix` | Biome 检查 / 自动修复，附带 `toDOM` 的 DOM 依赖静态检查 |
| `pnpm typecheck` | 全仓库 `tsc --noEmit` |
| `pnpm test` / `pnpm test:watch` | Vitest |
| `pnpm bench` | 性能基准与预算门禁，超预算即失败（见 [`docs/performance-budgets.md`](docs/performance-budgets.md)） |
| `pnpm render <doc.json>` | 纯 Node 环境从文档 JSON 渲染 HTML，**不需要 jsdom** |
| `pnpm demo:remote-image-service` | 启动远端图片转存的本地演示服务 |

CI 的 `Quality` 检查按顺序跑 `check` → `typecheck` → `test` → `bench` → commitlint。

## 用起来长什么样

编辑器实例由业务创建（框架无关），框架适配层只负责挂载、订阅与渲染：

```tsx
import { createEditor } from "@kaelen/editor-api";
import { EditorContent, EditorProvider } from "@kaelen/editor-react";
import { EditorToolbar } from "@kaelen/editor-react-ui";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { createTablePlugin } from "@kaelen/editor-plugin-table";

const editor = createEditor({
  plugins: [createLinkPlugin(), createTablePlugin()],
});

editor.loadDocument(envelopeFromServer);

function App() {
  return (
    <EditorProvider editor={editor}>
      <EditorToolbar definition={toolbar} />
      <EditorContent />
    </EditorProvider>
  );
}
```

保存走信封 JSON，或订阅增量：

```ts
import { DOCUMENT_JSON_LIMIT_BYTES } from "@kaelen/editor-shared-types";

const unsubscribe = editor.subscribe("patch", (patch) => sendToServer(patch));

// 全量保存前由宿主自己把 2MB 上限的关：保存是宿主的动作，编辑器只提供可判定的事实
if (editor.getDocumentSize() <= DOCUMENT_JSON_LIMIT_BYTES) {
  await save(editor.getDocument());
  editor.markSaved();
}
```

Vue 侧是同一套语义：`@kaelen/editor-vue` 提供 `EditorProvider` / `EditorContent` 与对应 Composable，`@kaelen/editor-vue-ui` 复用同一个 `editor-ui-model` 渲染工具栏。

## 架构一览

```text
业务应用（React / Vue）
        │
        ▼
editor-react / editor-vue          框架适配：挂载、订阅、渲染
        ├──▶ editor-react-ui / -vue-ui        仅渲染
        │            └──▶ editor-ui-model     工具栏状态机（无框架）
        ▼
editor-api                         稳定的业务接入接口 createEditor / RichEditor
        ▼
editor-runtime                     插件解析与降级、命令分发、事件、自动保存、熔断
        ├──▶ editor-schema         冻结核心 Schema + serializer（无 DOM，前后端共用）
        ▼
editor-pm-adapter                  Schema 装配、Session、剪贴板、外部 HTML、位置映射
        ▼
ProseMirror
```

| 包 | 职责 |
| --- | --- |
| `editor-shared-types` | 信封、`DocumentPatch`、事件、`CoreNodeSpec` 等共享协议。零依赖 |
| `editor-schema` | 冻结核心节点/标记、信封校验、迁移链、`DOMOutputSpec`→HTML 渲染 |
| `editor-pm-adapter` | ProseMirror 适配层：核心命令、剪贴板管线、外部 HTML 解析、Step ↔ PatchOp |
| `editor-runtime` | 插件拓扑排序与冲突降级、命令门禁、事件派发、自动保存、熔断 |
| `editor-api` | 面向业务的窄接口，**刻意不暴露任何 ProseMirror 类型** |
| `editor-plugin-{link,table,image,color}` | 可选能力，贡献 `co_` 前缀的节点与标记 |
| `editor-remote-image-service` | 远端图片转存策略与 SSRF 控制，可替换的服务契约 |
| `editor-ui-model` | 工具栏行为状态机与浮动工具栏定位，无框架 |
| `editor-{react,vue}` / `editor-{react,vue}-ui` | 框架挂载与渲染，不含编辑规则 |

分层的收益被明确定义为**业务侧接口治理与可测试性**，不是"未来可换内核"——换内核要重写全部插件与适配层。理由见方案 §5.2。

## 四条贯穿全局的约定

读代码前知道这四条，大部分设计就讲得通了：

1. **模型权威，DOM 只能被校正。** contenteditable 下浏览器和输入法会在应用不知情时改 DOM，任何"以 DOM 为事实"的路径都会失效。
2. **降级可以丢格式，不可以丢内容。** 缺插件的文档必须打得开：未知节点包成 `unknown_block` 原样保存并只读占位，保存时原样写回。规模超限只拦新写入，不拦装载。
3. **持久化名字是数据契约。** 冻结核心集不带前缀、永不改名；插件贡献的节点与标记一律 `co_` 前缀。改名等于全量数据迁移。
4. **位置是对旧文档的引用。** 上传、AI 改写、评论锚点、协同都持有过期位置，因此位置映射是核心机制而非实现细节；异步状态存 plugin state 而不是文档。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/prd-and-tech-design.md`](docs/prd-and-tech-design.md) | 需求说明与技术方案。架构、接口契约、安全边界、不可逆决策的**唯一权威来源** |
| [`docs/implementation-slices.md`](docs/implementation-slices.md) | 切片清单与当前交付状态，含未认领的欠账 |
| [`docs/performance-budgets.md`](docs/performance-budgets.md) | 性能基准口径与 CI 门禁阈值 |
| [`docs/y-prosemirror-compatibility.md`](docs/y-prosemirror-compatibility.md) | M4 协同的前置兼容性验证结论与接入边界 |
| [`AGENTS.md`](AGENTS.md) | 分支与 PR 流程、工具链、TDD 约定 |

`fixtures/clipboard/` 是剪贴板 golden 语料库：真实来源的原始剪贴板 dump 加黄金输出。粘贴逻辑每次改动都要跑全量 golden diff——这是唯一能防住"修了 Word 又坏了 Notion"的机制。

## 参与开发

`main` 是受保护的集成分支，一切改动走短生命周期分支加 PR。提交遵循 Conventional Commits，行为变更按红-绿-重构推进，每个缺陷修复都要带一条回归测试。完整约定见 [`AGENTS.md`](AGENTS.md)，架构约束以 [`docs/prd-and-tech-design.md`](docs/prd-and-tech-design.md) 为准。
