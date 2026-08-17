# 如何开发一个插件

这是一份操作指南：假设你已经会用编辑器（`createEditor` / `execute` / `subscribe`），现在要给它加一个可选能力。范式来自仓库里已交付的七个插件——link、table、color、image、ai、comment、version-history——它们各代表一类形态，写新插件时先找到最像的那个照着抄。另有一份**可执行的最小完整样例** [`tests/sample-plugin.ts`](../tests/sample-plugin.ts)：节点、标记、命令、只读查询四个注册点俱全，且只 import `@kaelen/editor-runtime` 一个包——它以测试形式钉住"写插件不需要碰 Core 内部"这句承诺。

架构约束的**为什么**不在本文里重复：命名空间与冻结核心集见方案 §9.2，缺插件兜底见 §9.3，插件模型见 §8.3，异步位置契约见 §9.5，降级与熔断见 §8.6（均在 [`prd-and-tech-design.md`](prd-and-tech-design.md)）。本文只讲**怎么做**，以及每一步会撞上哪些校验。

## 0. 一个插件是什么

`EditorPlugin`（定义在 `packages/editor-runtime/src/plugins.ts`）是一个纯对象，最多做四件事：

```ts
export interface EditorPlugin {
  name: string;            // 命令前缀、降级记录里的身份
  version: string;         // 包的 semver，与持久化数据无关
  namespace: "co_";        // 持久化节点/标记的强制前缀，当前固定
  structureVersion?: number; // 该插件持久化结构的版本，写进信封 plugins
  dependsOn?: string[];    // 依赖的其他插件名，按拓扑排序装载
  extendSchema?(schema: SchemaBuilder): void;        // 贡献节点/标记
  registerCommands?(commands: CommandRegistry): void; // 贡献 comment.* 这类命令
  createSessionExtensions?(): readonly SessionExtension[]; // 需要 PM 状态的能力
}
```

装载方式是宿主把它交给 `createEditor`：

```ts
const editor = createEditor({ plugins: [createMyPlugin()] });
```

三件事在你写第一行代码之前就要定：

1. **要不要贡献节点/标记。** 贡献了，文档里就会出现你的持久化结构，卸载后靠 `unknown_block`/`unknown_inline` 兜底显示（§9.3），协同下还会触发准入闸门（见 §6）。不贡献（ai、comment、version-history 都不贡献），插件卸载即无痕，协同零风险。**能不进文档就不进文档。**
2. **数据是"正文"还是"元数据"。** 上传进度、AI 预览、评论锚点都不是正文——它们放 plugin state 或信封的 `annotations`，绝不做成节点属性或 mark（§8.5、§9.8 的定论，别在实现时走回头路）。
3. **命令名。** 必须以 `${plugin.name}.` 打头（`comment` 插件只能注册 `comment.*`），否则该命令被忽略并记一条降级（不抛错、不白屏）。

## 1. 最小插件：只有命令

最短可用的形态，五分钟能跑（link 插件是它的完整版，下面的写法逐行来自它）：

```ts
import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";

const unboldCommand: SessionCommand = {
  // session 是 EditorSession 提供的窄操作面：标记增删、块判断、选区查询，
  // 见 editor-pm-adapter/src/session.ts。拿不到 EditorState，也不需要。
  run(session, apply) {
    if (!session.hasMarkInSelection("strong")) {
      return { ok: false, reason: "disabled" };
    }
    const ok = session.removeMarkOverSelection("strong", apply);
    return ok ? { ok: true } : { ok: false, reason: "disabled" };
  },
  enabled: (session) => session.hasMarkInSelection("strong"),
  active: (session) => session.isMarkActive("strong"),
};

export function createUnboldPlugin(): EditorPlugin {
  return {
    name: "unbold",
    version: "1.0.0",
    namespace: "co_",
    registerCommands: (commands) => {
      commands.add("unbold.clear", unboldCommand); // 前缀必须是 "unbold."
    },
  };
}
```

命令契约（`SessionCommand`，见 `editor-pm-adapter/src/commands.ts`）：

- `run(session, apply, input)`：`apply === false` 是工具栏的可行性试跑，**不许改状态**；`input` 是宿主透传的任意 JSON，自己校验形状（参考 comment 插件的 `addInputFrom`——非法输入返回 `{ ok: false, reason: "invalid", detail: "人话" }`，不要抛错）。
- `enabled?(session, input)`：可选的无副作用可用性判断；不提供时 runtime 用 `run(_, false, input)` 代替。
- `active(session, input)`：工具栏点亮态。
- `readOnly: true`：只读态仍可执行（仅限不改文档的命令）。

三态门禁、组合态拒绝（`reason: "composing"`）、熔断都由 runtime 统一处理，命令里不用管。

## 2. 贡献节点或标记

以 link（标记）和 image（节点）为参照。规则全部由 `resolvePlugins` 在启动时校验，违反不会抛错白屏，而是**降级启动**并留下 `PluginError` 记录：

| 你做了什么 | 结果 |
| --- | --- |
| 节点/标记名不带 `co_` 前缀 | 整个插件禁用（`invalidName`） |
| 与冻结核心集（`paragraph`、`strong`……）或先装插件重名 | 整个插件禁用（`duplicateNode` / `duplicateMark`）；Schema 是半个都不能提交的，所以是整体禁用而不是丢一个节点 |
| 命令与已有命令重名 / 不带插件名前缀 | 只丢那一条命令，插件其余能力保留 |
| 插件重名 / `dependsOn` 缺失或成环 | 后注册者（或整个环）禁用 |
| `extendSchema` / `registerCommands` 抛错 | 整个插件禁用 |

节点/标记规格是**声明式**的 `CoreNodeSpec` / `CoreMarkSpec`（`editor-shared-types`），没有可执行的 `getAttrs` 钩子——服务端要拿同一份规格渲染 HTML（§12.1）。四种表达跟着定义走，缺一个就有一条链路默默断掉：

- `toDOM` / `parseDOM`：编辑器与服务端渲染。渲染处必须自带安全校验（link 的协议白名单在 `toDOM` 里再判一次——文档可能来自 localStorage 或导入，不能信任何来路）。
- `toMarkdown` / `fromMarkdown`：导出与导入。缺省即"Markdown 表达不了"，按丢格式不丢文字降级。

**`structureVersion`**：你的持久化结构的版本，与包版本无关。装载文档时 runtime 把它记进信封的 `plugins[name]`（已有记录不覆盖）。加字段时若旧文档靠 Schema 默认值就能读（image 从 1 → 2 就是这么做的），只改数字即可；不兼容的结构改动需要迁移函数，目前经宿主的 `createEditor({ migrations })` 提供（`DocumentMigration`，§12.2）。

## 3. 异步能力：SessionExtension 与 §9.5 五条

要用 Decoration、位置映射、派发事务，就返回一个 `SessionExtension`（image 与 ai 是两份完整参照，comment 是批注变体）：

```ts
interface SessionExtension {
  plugins(schema: Schema): readonly Plugin[];   // 贡献 PM 插件（plugin state / decorations）
  bind?(bridge: SessionBridge): void;           // 拿到 { schema, getState, dispatch }
  unmount?(): void;                             // StrictMode 会 mount→unmount→mount
  destroy?(): void;
  loadAnnotations?(annotations): void;          // 见 §4
  annotations?(): readonly Annotation[];
}
```

ProseMirror 类型止步于插件层：`SessionBridge` 是异步结果回到唯一事务入口的通道，业务 API 永远见不到 `Transaction`。

任何"发起时算了位置、结果晚点才回来"的功能（上传、AI、评论跳转……）必须逐条满足 §9.5：

1. **请求态存 plugin state，不进文档。** 用 `PluginKey` + `state.apply` 管理记录（ai-plugin 的 `AiRequestRecord` 照抄）。
2. **每一笔事务重映射位置。** 在 `apply(tr, value)` 里对 `tr.docChanged` 用 `tr.mapping` 迁移 `from/to`。两端偏向刻意相反：`from` 偏后（`mapResult(from, 1)`）、`to` 偏前（`mapResult(to, -1)`），贴着区间外侧新打的字不会被圈进来。ai-plugin 的 `mapRange` 是最干净的一份。
3. **目标消失就丢弃。** 两端撞在一起（`end.pos <= start.pos`）说明区间被删了：丢弃结果、中止请求（ai 的 `abortOrphans`），评论则置 `orphaned` 不删本体。
4. **过程提示用 Decoration。** 不往文档里塞占位文本。
5. **回填以映射后的位置构造。** 回填进不进历史看一条判据：**这次异步操作在文档里留没留下中间态**。图片回填不进历史（进历史的是"插入占位图"那一笔）；AI 回填进历史（生成期间文档一字未动，这一笔就是用户那次编辑本身）。§9.5 的补记写了完整推理。

组合态（输入法）不用你处理：`bridge.dispatch` 的改文档事务在组合期间自动排队、结束后按映射冲刷；覆盖组合中文本块的 Decoration 由会话自动冻结。你只要保证**所有事务都走 `bridge.dispatch`**，别的入口没有。

清理义务：`unmount` 中止在飞的请求（StrictMode 双挂载会真的走到），`destroy` 释放全部资源。

## 4. 批注类能力：annotations 权威

实现 `SessionExtension` 的 `loadAnnotations` + `annotations` 两个方法，插件就成为信封 `annotations` 字段的运行时权威：装载文档时收到信封里的批注，`getDocument()` / `getAnnotations()` 从你这里取活数据。**最多一个插件实现它**（当前是 comment）。锚点语义、协同批注表、`orphaned` 判据见 §9.8 及其补记——写第二个批注类插件之前先把那节读完。

## 5. 降级与熔断：你的插件会怎么"坏"

- **启动期**：上面 §2 的表。宿主经 `getPluginErrors()` 与 `pluginError` 事件拿到全部记录。
- **运行期**：插件命令抛错时状态整体回滚到出错前（O(1) 检查点），错误计入滑动窗口——**60 秒内 3 次即本会话停用**（`BREAKER_THRESHOLD`）。单次抛错不停用：一条坏输入不该让功能消失。
- 对你的要求：可预期的失败（非法输入、目标消失）返回 `{ ok: false }`，不要抛错——抛错是在消耗熔断配额；真正的缺陷才让它抛，回滚会保住用户的文档。

playground 的"注入故障插件"开关演示了每一种坏法，改完插件在那里点一遍。

## 6. 协同注意事项

- **新增 `co_` 节点/标记 = 提高协作门槛。** 准入闸门只认共享文档里的节点名与标记名：没装你插件的协作者一旦收到含你节点的更新，会被**整体拒绝并退出协作**（不是降级——y-prosemirror 会替所有人删掉它认不出的内容，详见 [`y-prosemirror-compatibility.md`](y-prosemirror-compatibility.md)）。这条代码兜不住：同一份协作文档的参与者必须装兼容的插件集，是宿主分发链接时的运营责任。所以再说一遍：**能不进文档就不进文档。**
- **不进文档的数据天然安全。** plugin state 本来就不同步；要跨端同步的元数据放共享 `Y.Doc` 的顶层结构（comment 的批注表是范例，桥接收在 `editor-pm-adapter/src/annotation-anchors.ts`，闸门对纯 JSON 数据天然放行）。
- **位置在协同下不是数字。** 远端事务是整篇替换，`tr.mapping` 对它没有意义；要跨事务存活的锚点用 `Y.RelativePosition`（同上，参照 comment）。本地事务照常用 §9.5 的扁平映射。
- 插件表在协同绑定时会重建（`reconfigure`），你的 plugin state 会重新 `init`——绑定后共享文档才是事实来源，别指望本地状态迁移过去。

## 7. 收尾清单

- **包**：`packages/editor-plugin-<name>`，依赖只允许 `editor-pm-adapter` / `editor-runtime` / `editor-schema` / `editor-shared-types`（`scripts/lint-dependencies.mjs` 强制；测试可在 devDependencies 用 `editor-api` 等上层包装真编辑器）。
- **测试**：红-绿-重构（AGENTS.md）。用探针模式拿 `SessionBridge` 精确设选区、派发编辑（各插件测试文件里的 `createProbe` 照抄）；协同行为用 `CollabRoom` + 内存网线（comment / version-history 的 collab 测试是模板）。异步能力至少钉住：位置迁移、贴边输入不被吞、目标消失丢弃、撤销语义。
- **门禁**：`pnpm check && pnpm typecheck && pnpm test`；改了 playground 再跑 `pnpm e2e`。e2e 只放 jsdom 验不了的东西（组合态、真实网络），不做第二套功能回归。
- **演示**：接进 `apps/playground`（工具栏项 + 必要的面板），那是每一片的验收场地。

## 参考：七个插件各代表什么

| 插件 | 形态 | 值得抄的点 |
| --- | --- | --- |
| link | 标记 + 命令 | 声明式 Schema、同一条白名单在 parse/render/export 三处出现 |
| table / color | 结构节点 / 标记族 | `tableRole`、成套命令的组织 |
| image | 节点 + 异步上传 | §9.5 全套、"上传态不进文档"、NodeSelection 交互 |
| ai | 纯命令 + 异步回填 | 最干净的 §9.5 实现、流式合流、拒答是返回值不是异常 |
| comment | 批注权威 + 协同同步 | annotations 接口、共享批注表、`Y.RelativePosition` 锚点 |
| version-history | 纯命令 + 宿主数据 | 命令接收宿主累积的数据、派发前全等校验、`closeHistory` |
