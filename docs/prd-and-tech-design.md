# 富文本编辑器需求说明与技术方案

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档名称 | 富文本编辑器需求说明与技术方案 |
| 编辑内核 | ProseMirror |
| 接入框架 | React（M1）、Vue（M2，接入时间待确认） |
| 架构目标 | 内核无框架、能力插件化、框架适配层解耦、业务侧接口治理 |
| 文档格式 | 版本化信封 JSON 为唯一事实来源；HTML / 纯文本 / Markdown 为交换格式 |
| 关键约束 | 见 §5.1 第一性原理、§5.2 对抗式决策结论、§19 不可逆决定清单 |

---

## 2. 背景与目标

业务需要具备结构化内容编辑能力，并可在 React 与 Vue 应用中复用。编辑器需要支持常见富文本、表格、图片、链接与复制粘贴能力，并为协同编辑、评论、AI 能力等后续功能预留扩展空间。

### 2.1 建设目标

- 提供一致、稳定的富文本编辑体验，包含中文输入法场景下的稳定性。
- 以结构化文档 JSON 作为唯一可信内容模型，避免以 HTML 作为唯一存储格式。
- 将编辑内核、功能插件与框架 UI 解耦，实现 React/Vue 的低成本接入。
- 安全处理来自浏览器剪贴板、网页、Word、Excel 的不可信内容。
- 允许按需安装与升级插件，且**插件缺失或版本落后时不得导致用户内容丢失**。
- 为协同、评论、版本历史、AI 能力提供必要的底层原语（增量变更、位置映射），而不必在首期实现这些功能。

### 2.2 非目标

- 首期不追求 Word 的分页、浮动排版、页眉页脚等桌面排版能力。
- 首期不保留外部网页或 Word 的全部字体、边距、颜色及私有样式。
- 首期不实现多人协同、评论和修订，但必须完成 §19 中与之相关的架构决策。
- **不以"未来更换编辑内核"为架构目标。** 本方案的插件契约（Schema、NodeSpec/MarkSpec、NodeView、内容表达式）在概念上与 ProseMirror 同构，更换内核意味着重写全部插件与适配层。分层的真实收益是业务侧接口治理与可测试性，不是内核可替换性（见 §5.2）。
- 首期不支持移动端原生/RN 宿主；但移动端浏览器（触屏选区、虚拟键盘）在支持范围内。
- 首期不做协作光标、修订痕迹、批注面板 UI。

---

## 3. 用户与场景

| 用户/场景 | 主要诉求 |
| --- | --- |
| 内容编辑者 | 编写段落、标题、列表、链接、图片、表格与代码内容；中文输入法下不丢字、不断字。 |
| 文档使用者 | 复制内容到其他应用，并从网页、Word、Excel 等来源粘贴内容。 |
| 业务开发者 | 在 React（M1）或 Vue（M2）中以统一 API 集成编辑器及工具栏。 |
| 平台开发者 | 独立开发、发布、配置和升级编辑器能力插件。 |
| 服务端 | 从文档 JSON 渲染 HTML 用于预览/发布/搜索；不接受客户端提交的 HTML。 |
| 无障碍使用者 | 键盘完成全部编辑操作；屏幕阅读器可读工具栏与结构（见 §15）。 |

> **待确认**：Vue 的实际接入方与上线时间。内核已保证框架无关，因此推迟 Vue 适配层的成本为零，而与 React 并行开发的成本是立刻翻倍（两套 NodeView 桥、两套 UI、两套测试）。若无明确的 Vue 业务方与时间点，Vue 适配层保持在 M2。

---

## 4. 功能需求

### 4.1 基础编辑

- 块级：段落、标题（h1–h4）、引用、分隔线、无序/有序列表、待办列表、代码块。
- 行内：粗体、斜体、下划线、删除线、行内代码、链接。
- 交互：撤销、重做、快捷键、选区、**输入法组合态**（见 §9.6）与拖拽编辑。
- 状态：编辑态、只读渲染态、禁用态（三者语义不同：只读可选中可复制，禁用不可聚焦）。

标题层级为产品决策而非技术限制：从 h1–h4 扩展到更多层级是纯增量变更，不需要数据迁移；因此首期收窄，粘贴时按 §11.4 降级。

### 4.2 扩展内容

- 表格：插入、增删行列、合并单元格（保留 `colspan`/`rowspan`）、复制粘贴表格、键盘导航（见 §15）。
- 图片：本地选择、拖入、剪贴板粘贴、上传状态、失败重试；以及非破坏性的二次编辑（尺寸、裁剪、旋转、滤镜、环绕、替代文本、替换资产）。
- 文字颜色与背景色：由插件贡献 `co_text_color` / `co_background_color` 两个标记。它们是可选能力而非核心集，因此卸载插件后按 §9.3 丢标记保文本。
- 代码块：指定语言；粘贴进代码块时一律按纯文本处理。
- 可扩展：@ 提及、附件、公式、嵌入卡片、任务块。

### 4.3 内容存储与渲染

- 主存储格式为**信封化版本 JSON**（见 §9.1），文档体为纯 ProseMirror 节点 JSON。
- 支持 JSON → HTML 渲染，前后端共用同一 serializer（见 §12.1）。
- 支持 HTML / Markdown 导入导出；不支持的结构必须有明确降级策略，且**降级不得丢弃原始内容**。
- 文档读取时执行 Schema 校验与版本迁移；遇到未知节点走 §9.3 兜底而非报错。

### 4.4 中文与国际化要求

- 智能标点替换（直引号转弯引号等）默认**关闭**且可配置：中文场景下会把中文引号改错。
- 中英混排间距、全角/半角标点不做自动改写，只做渲染层视觉优化。
- 字数统计按 Unicode 字符计数（CJK 按字），另提供"不含空白字符"口径；不使用按空格分词的 word count。
- 文本方向首期仅支持 LTR；RTL 进入非目标但 Schema 不做阻断性假设。

---

## 5. 关键原则与决策

### 5.1 第一性原理

编辑器要解决的根本问题是：**在一个不归你所有的编辑表面上，维护一份结构化内容。** contenteditable 下，浏览器、输入法、自动纠错、拖拽、系统级操作都会在应用不知情时修改 DOM。由此推出四条不可绕过的约束：

1. **模型权威，DOM 只能被校正。** 任何"直接以 DOM/HTML 为事实"的路径都会在浏览器差异与输入法介入下失效。
2. **位置是对旧文档的引用。** 任何跨越一次以上变更的操作（上传、AI 改写、远端协同、评论锚点、异步校验）都持有过期位置，因此**位置映射是核心机制而非实现细节**（§9.5）。
3. **选区是用户的心智状态，不可推导。** 每次模型变更都必须显式决定选区归属，否则光标乱跳是必然结果。
4. **撤销单元 ≠ 事务单元。** 程序化产生的事务（上传结果回填、格式规范化、远端变更）不能进入用户历史（§9.4）。

在此之上，跨信任边界的内容迁移（剪贴板、导入、服务端渲染）遵循：

5. 剪贴板 HTML 是输入，不是内部文档。
6. 结构化 JSON 是唯一可信、可演进的事实来源。
7. 外部格式只保留语义结构，丢弃会污染版式或无法安全验证的视觉样式。
8. 不能可靠转换时，优先安全、可编辑的降级结果；**降级可以丢格式，不可以丢内容**。

第 8 条同样适用于加载自己的文档：插件缺失时必须降级为可保存的占位内容（§9.3），而不是加载失败。

### 5.2 对抗式决策结论

| 方案主张 | 风险/反驳 | 决策 |
| --- | --- | --- |
| 直接插入 HTML | XSS、Word 垃圾样式、结构不符合文档 Schema | 禁止直接插入；必须解析为 Schema 结构后插入。 |
| 一律转纯文本 | 丢失表格、链接、列表、图片等高价值语义 | 仅作为降级路径与"无格式粘贴"。 |
| 保留一切外部格式 | 跨端不一致、内容污染、实现成本无限增长 | 只保留标题、列表、表格、文本样式等语义格式。 |
| 用手写 sanitizer 删危险标签作为安全边界 | 手写 HTML sanitizer 是必输的军备竞赛（mXSS、命名空间混淆、解析差异） | 安全边界是 **Schema 即白名单**：只有 Schema 能表达的结构才能存在，其余构造性丢弃（§11.3）。 |
| 自定义 MIME 作为编辑器间高保真通道 | Safari 丢弃非标准剪贴板类型；异步 Clipboard API 仅允许安全列表；经中间应用会丢失 | 高保真 payload 由 `text/html` 承载；自定义 MIME 仅作可选加速通道（§11.1）。 |
| 复制时序列化 Fragment | 跨列表项/表格/段落中部的选区需要开合深度，否则粘贴层级错乱 | 序列化 **Slice**（含 `openStart`/`openEnd`）。 |
| 异步结果按"节点 ID"回填 | ProseMirror 节点是不可变持久值，**没有身份**；复制会产生重复 ID，撤销会使回填目标消失 | 上传态移出文档，用插件 state + Decoration 随 mapping 迁移（§9.5、§8.5）。 |
| 单一全局 doc version + 严格 Schema 校验 + 插件独立升级 | 三者交点是"缺插件即文档打不开"，属数据丢失 | 信封记录 per-plugin 版本 + `unknown_block` 兜底节点（§9.1、§9.3）。 |
| 业务只能用 `execute(command)`，一律不暴露变更原语 | 协同、增量保存、版本历史、评论锚点、AI patch 全部需要增量变更；接口会在 M4 被迫破坏性重构 | 定义平台自有的 `DocumentPatch`（§8.4），M1 即产出；业务 API 仍保持窄。 |
| 让业务直接依赖 Tiptap | 业务与上层封装绑定，跨框架治理困难 | 业务只依赖自有 Editor API。 |
| 分层的收益是"未来可换内核" | 换内核要重写全部插件/NodeView/剪贴板规则，能复用的只有最便宜的方法签名 | 保留分层，但收益重定义为业务侧治理与可测试性；换内核进非目标（§2.2）。 |
| 每个 NodeView 一个 React root | 大文档产生数百个独立 reconciler，且 NodeView **脱离宿主 React 树、拿不到任何 context** | 用 portal / Teleport 渲染进宿主树（§9.7）。 |
| 工具栏行为交给各框架 UI 实现 | 分组、启用/激活计算、焦点顺序是行为不是外观；两套实现必然漂移 | 抽出无框架的 `editor-ui-model` 状态机（§10.4）。 |

---

## 6. 总体技术架构

```text
业务应用（React / Vue）
        │
        ▼
@kaelen/editor-react / @kaelen/editor-vue         框架适配：挂载、订阅、渲染
        │
        ├──▶ @kaelen/editor-react-ui / -vue-ui     仅渲染
        │            │
        │            ▼
        │    @kaelen/editor-ui-model               工具栏/浮层状态机（无框架）
        ▼
@kaelen/editor-api                                稳定的业务接入接口
        │
        ▼
@kaelen/editor-runtime                            插件调度、命令、事件、自动保存、熔断
        │
        ├──▶ @kaelen/editor-schema                 核心 Schema + serializer（前后端共用，无 DOM 依赖）
        ▼
@kaelen/editor-pm-adapter                         Schema 装配、EditorState、Transaction、EditorView、
        │                                          剪贴板管线、外部 HTML 解析、位置映射
        ▼
ProseMirror
```

包名前缀是 `@kaelen/`，所有包当前均为 `private: true` 的 workspace 内部包，尚未发布到 registry。

剪贴板管线与位置映射落在 `editor-pm-adapter` 而不是 `editor-runtime`：两者都要直接操作 `Slice`、`Transaction` 和 `Mapping`，放在 runtime 会让 runtime 重新长出 ProseMirror 依赖，§7.1 的分层约束就白设了。

Tiptap 可用于原型开发、借鉴 Extension 实现或快速引入成熟能力，但不作为业务层直接依赖，也不应将其 React/Vue 包作为平台内核。

---

## 7. 包结构与职责

```text
packages/
  editor-shared-types/          # 共享类型与协议（Envelope、DocumentPatch、事件、CoreNodeSpec）。零依赖
  editor-schema/                # 冻结核心 NodeSpec/MarkSpec + 信封 + 迁移链 + DOMOutputSpec→HTML serializer
  editor-pm-adapter/            # ProseMirror 适配：Schema 装配、Session、核心命令、剪贴板、外部 HTML、Patch 转换
  editor-runtime/               # 插件解析与降级、命令分发、事件、自动保存、熔断
  editor-api/                   # 面向业务的稳定接口 createEditor / RichEditor
  editor-plugin-link/           # co_link 与协议白名单
  editor-plugin-table/          # co_table 系列节点与表格命令
  editor-plugin-image/          # co_image、AssetUploader、上传态 Decoration、二次编辑属性
  editor-plugin-color/          # co_text_color / co_background_color 两个标记
  editor-remote-image-service/  # 远端图片转存策略与 SSRF 控制（可替换服务契约，无 DOM 依赖）
  editor-ui-model/              # 工具栏状态机与浮动工具栏定位（无框架）
  editor-react/                 # React Provider、Hooks、内容容器
  editor-react-ui/              # React 工具栏渲染
  editor-vue/                   # Vue Provider、Composables、内容容器
  editor-vue-ui/                # Vue 工具栏渲染

apps/
  playground/                   # 每一片的演示场地（React）
  remote-image-service/         # 远端图片转存的 Node 演示服务
```

两处与早期规划不同，都是刻意的：

- **没有 `editor-plugin-basic`。** 基础块与文本样式属于冻结核心集，Schema 在 `editor-schema`、命令与快捷键在 `editor-pm-adapter` 的核心命令表。把它们做成插件等于让"能被卸载"这件事发生在核心集上，与 §9.2 的冻结承诺矛盾。
- **没有 `editor-plugin-clipboard`。** 复制粘贴要直接操作 `Slice`/`Transaction`，且核心块本身就需要复制粘贴；它是内核能力而不是可选能力，因此落在 `editor-pm-adapter`（`clipboard.ts`、`external-html.ts`）。

### 7.1 分层约束

- `editor-api` 不暴露 `EditorState`、`Transaction`、`Node`、`PluginKey` 等 ProseMirror 类型。**理由是业务侧治理与可测试性**（业务不能派发事务、不能持有可变内部状态、接口可 mock），不是内核可替换性。
- `editor-runtime` 不依赖 React、Vue 或任何框架 UI。
- `editor-schema` 不依赖 DOM、不依赖框架、不依赖 ProseMirror 视图层；可在 Node 与浏览器中运行同一份代码。
- 能力插件只通过 Schema、Command、Clipboard、NodeView 等注册中心扩展 runtime，不直接修改内部状态。
- React/Vue 适配层不包含编辑规则；其职责是挂载 DOM、订阅状态与渲染 UI。
- 工具栏**行为**属于 `editor-ui-model`，框架 UI 只决定外观（§10.4）。
- 插件的 `toDOM` 只能返回 `DOMOutputSpec` 数组结构，**禁止访问 `document` 或任何 DOM API**（§12.1 依赖此约束在服务端渲染）。以 lint 规则 + 单测强制。

---

## 8. 核心接口设计

### 8.1 业务编辑器接口

当前已实现的业务接口如下：

```ts
export interface RichEditor {
  // ---- 文档读写 ----
  /** 返回当前只读信封快照；同一状态下多次调用返回同一引用。 */
  getDocument(): EditorEnvelope
  /** 初始化装载：清空历史，不产生可撤销记录，不触发 contentChanged 的用户变更语义。 */
  loadDocument(input: EditorEnvelope | NodeJSON): LoadResult
  /** 从 JSON 渲染 HTML（与服务端同一实现）。 */
  getHTML(): string

  // ---- 命令 ----
  execute(command: string, input?: unknown): CommandResult
  /** 工具栏所需状态：能否执行、当前是否生效。 */
  queryCommand(command: string, input?: unknown): CommandQuery

  // ---- 三态与选区 ----
  /** 编辑态 / 只读态 / 禁用态，语义不同，不能用一个布尔量表达（§4.1）。 */
  getMode(): EditorMode
  setMode(mode: EditorMode): void
  getSelectionState(): SelectionSnapshot

  // ---- 状态 ----
  /** 引用稳定的状态快照，供 useSyncExternalStore / Vue computed 使用（见 §10.2）。 */
  getSnapshot(): EditorSnapshot
  isDirty(): boolean
  /** 宿主完成持久化后调用，清除脏标记且不影响撤销历史。 */
  markSaved(): void
  /** 单调递增修订号，用于自动保存与冲突检测。 */
  getRevision(): number
  /** 已发生的插件降级记录，含宿主能订阅之前的启动期冲突（§8.3、§8.6）。 */
  getPluginErrors(): readonly PluginError[]

  focus(): void
  undo(): CommandResult
  redo(): CommandResult

  // ---- 生命周期（见 §8.2）----
  mount(element: HTMLElement): void
  unmount(): void
  destroy(): void

  // ---- 事件 ----
  subscribe<K extends EditorEventName>(
    event: K,
    listener: (payload: EditorEventPayload[K]) => void,
  ): () => void
}

export interface CommandResult {
  ok: boolean
  /** 失败原因可判别，便于线上定位。 */
  reason?: 'disabled' | 'destroyed' | 'invalid' | 'pluginError' | 'composing'
  detail?: unknown
}

export interface CommandQuery {
  enabled: boolean
  /** 选区当前是否整体处于该命令的生效状态。 */
  active: boolean
}

export interface SelectionSnapshot {
  empty: boolean
  marks: string[]
  blockType: string
  /** 从 doc 到当前块的节点名路径，供 UI 判断上下文（是否在表格/代码块/列表内）。 */
  path: string[]
  composing: boolean
}
```

`replaceDocument`、`parseHTML`、`batch` 与命令返回 `value` 是后续候选扩展，当前未公开；业务接入不得依赖它们。

设计要点：

- `getDocument()` 按状态缓存。它是 JSON 兼容的只读快照（因 §7.1 不暴露 `Node`），调用方必须自行克隆后再改写；频繁保存改走 §8.4 的增量 patch。
- `getSnapshot()` 的返回值必须引用稳定（同一状态返回同一对象）。React 18 的 `useSyncExternalStore` 要求 `getSnapshot` 可缓存，每次返回新对象会直接抛 `The result of getSnapshot should be cached`。
- `queryCommand` 的存在是为了让工具栏不必调用 `getDocument()`。缺少 `active` 会迫使 UI 每次选区变化就全量序列化文档。
- `isDirty()` 只读不写，脏标记的清除必须由宿主显式 `markSaved()`。编辑器不知道宿主什么时候把内容落了盘，替它猜就会在保存失败时把脏标记也一起丢掉。
- `getPluginErrors()` 与 `subscribe('pluginError')` 并存，因为启动期的插件冲突发生在宿主拿到实例、能订阅之前。只有事件的话，这批错误谁也看不到。它在没有新记录时返回同一引用，可直接喂给 `useSyncExternalStore`。

### 8.2 生命周期规则

`create/destroy`（实例生命周期，业务拥有）与 `mount/unmount`（视图生命周期，框架适配层拥有）是两组**正交**操作：

- `mount(el)` / `unmount()` 必须幂等且可重复配对调用。React 18 StrictMode 在开发模式下会 mount → unmount → mount，若二者不幂等或 unmount 误走 `destroy()`，开发环境直接不可用（典型症状：内容消失或 `view already destroyed`）。
- `destroy()` 之后任何方法调用返回 `{ok:false, reason:'destroyed'}`，不抛异常。
- 卸载不清空文档状态：`unmount` 后 `getDocument()` 仍可用。

### 8.3 插件接口

当前已实现的插件契约（`@kaelen/editor-runtime`）：

```ts
export interface EditorPlugin {
  name: string
  version: string
  /** 持久化节点/标记名的全局前缀。类型即约束：当前只允许 `co_`（§9.2）。 */
  namespace: 'co_'
  /**
   * 该插件贡献的**文档结构**版本，写进信封的 `plugins`。与包的 semver `version`
   * 不同：它是持久化数据的版本，由插件自己的迁移函数推进。
   */
  structureVersion?: number
  dependsOn?: string[]

  extendSchema?(schema: SchemaBuilder): void
  registerCommands?(commands: CommandRegistry): void
  /**
   * 需要 Decoration、位置 mapping 等 ProseMirror 状态的能力（如图片上传态）由此接入。
   * 桥接类型止于 adapter 与插件层，业务侧 API 不会因此拿到 ProseMirror 对象（§7.1）。
   */
  createSessionExtensions?(): readonly SessionExtension[]
}
```

`namespace` 写成字面量类型 `'co_'` 而不是 `string`，是因为它本来就只有一个合法取值：允许插件自选前缀等于允许它自选一个未来会和别人撞车的命名空间，而撞车的代价是全量数据迁移（§9.2）。类型层挡住比启动期报错更早。

尚未实现、仍在契约规划中的钩子（当前由核心承担或尚无消费者，实现时按此形状补）：

| 规划中的钩子 | 现状 |
| --- | --- |
| `registerShortcuts` | 快捷键目前由 `editor-pm-adapter` 的核心 keymap 统一注册，插件命令经命令名接入。 |
| `registerClipboard` | 剪贴板管线是内核能力（§7），插件暂不注入自定义规则。 |
| `registerNodeViews` | 当前尚无自定义 NodeView：图片上传态用 Decoration 表达（§8.5）。 |
| `registerMigrations` | 迁移链已实现，但目前经 `createEditor({ migrations })` 由宿主传入，尚未开放给插件自持。 |
| `onCreate` / `onDestroy` / `onCompositionChange` | 组合态已由 runtime 全局把关（§9.6），插件暂无需要感知它的能力。 |

命名规则区分两类名字：

| 名字 | 是否持久化 | 命名空间要求 |
| --- | --- | --- |
| 命令名、事件名、快捷键 | 否 | 以插件名做前缀即可：`table.insert`、`image.retry`、`link.open`。可自由重命名。 |
| **节点名、标记名、属性名** | **是**（写进用户文档） | 必须带全局前缀（§9.2）。改名等于全量数据迁移。 |

加载顺序按依赖拓扑排序。冲突处理**不再是启动失败**：一个第三方插件重名不应让宿主应用白屏。

| 冲突类型 | 处理 |
| --- | --- |
| 循环依赖 | 涉及的插件全部禁用，其余正常启动，发 `pluginError`。 |
| 重复节点名/标记名 | 后注册者禁用（先注册者胜出，顺序由拓扑排序确定），发 `pluginError`。 |
| 重复命令名 | 后注册者的该命令被忽略，插件其余能力保留。 |
| 缺失依赖 | 该插件禁用，依赖它的插件递归禁用。 |

任何禁用都必须产生可诊断错误（插件名、冲突项、冲突对方）并可通过 `subscribe('pluginError')` 上报。

### 8.4 变更描述（DocumentPatch）

M4 的协同、评论锚点、版本历史、AI 改写，以及 M1 就需要的增量自动保存，都依赖"增量变更"这一原语。全量 JSON 不能承担：10 万字文档每次保存传输数 MB，且整篇替换会毁掉撤销栈与选区。

```ts
export interface DocumentPatch {
  /** patch 格式版本，与 schemaVersion 独立演进。 */
  v: 1
  /** 变更前后的文档修订号。 */
  from: number
  to: number
  ops: PatchOp[]
  /** 逆变更，用于服务端回滚与本地重放。 */
  inverse: PatchOp[]
}

export type PatchOp =
  | { type: 'replace'; from: number; to: number; slice: SliceJSON }
  | { type: 'attr'; pos: number; attrs: Record<string, unknown> }
  | { type: 'mark'; from: number; to: number; mark: MarkJSON; add: boolean }
```

- 位置为文档扁平偏移量，其语义是**持久化契约**的一部分，与 §9.1 的 schemaVersion 一起版本化。
- `DocumentPatch` 定义在 `editor-shared-types`，是平台自有类型，不是 ProseMirror `Step` 的再导出；由 `editor-pm-adapter` 双向转换。
- 开放范围：平台自身（协同、保存、评论、AI 插件）与服务端。业务 `RichEditor` 接口不直接暴露构造 patch 的能力，只通过 `subscribe('patch')` 消费。这样既解锁了 M4，又不放宽业务侧接口。
- **必须在 M1 交付。** 事后为全链路补一条变更流，成本比一开始就有它高一个数量级。

### 8.5 图片上传协议与异步状态

```ts
export interface AssetUploader {
  upload(file: File, options: { uploadId: string; signal: AbortSignal }): Promise<UploadedAsset>
  /** 上传成功但目标位置已不存在时调用，避免对象存储产生孤儿文件。 */
  discard?(asset: UploadedAsset): Promise<void>
}

export interface UploadedAsset {
  url: string
  alt?: string
  width?: number
  height?: number
}
```

**上传状态不进文档。** 文档中的图片节点只有 `{ src: '' | url, alt, width, height }`；`uploadId`、进度、错误信息保存在图片插件的 plugin state 中，位置随每个事务 `mapping.map()` 迁移，通过 `Decoration` 渲染占位与进度条。

理由与后果（这是原方案"按节点 ID 更新"不成立的地方）：ProseMirror 的 `Node` 是不可变持久值，**没有身份**——属性相同的两个节点在模型里完全可互换。因此必须明确以下行为：

| 场景 | 规则 |
| --- | --- |
| 上传中的节点被复制粘贴 | 粘贴侧剥离占位状态，视为空图片节点；禁止出现两个同 `uploadId` 的待回填目标。 |
| 上传中的节点被撤销删除，随后上传成功 | 丢弃回填结果，调用 `uploader.discard()` 释放已上传对象；redo 恢复的节点为空图片并允许重新上传。 |
| 回填事务与用户历史 | 回填、规范化、远端变更等程序化事务统一标记不进历史（§9.4）。用户按 undo 不得回退到 loading 态。 |
| 上传过程中编辑器 unmount | `AbortSignal` 触发，进行中的上传取消。 |
| 失败重试 | 由 plugin state 中的位置重新定位，而非记录当时的光标位置。 |

### 8.6 插件错误与熔断

"插件异常不破坏主编辑器"必须写成可执行策略，否则不可兑现：插件能 `appendTransaction`、能提供 NodeView、能改 Schema，在 `appendTransaction` 中抛错会让事务链处于未定义状态，NodeView 的 `update` 抛错会让 DOM 与模型失同步——这类错误一般不可就地恢复。

策略：

1. runtime 包裹全部插件入口点（命令、appendTransaction、剪贴板规则、NodeView 生命周期、迁移函数）。
2. 捕获异常 → 禁用该插件 → 以最后一次已知良好文档重建 `EditorView` → 发 `pluginError` → 宿主展示用户可见的降级提示（例："表格功能暂时不可用，内容已保留"）。
3. 熔断阈值：同一插件在 60 秒内抛错 ≥ 3 次即在本会话内永久禁用，不再重试重建。
4. 重建时保留选区位置（尽力而为，失败则置于文档起始）。

---

## 9. ProseMirror 内核设计

### 9.1 文档模型与信封格式

核心通过插件收集 `NodeSpec`、`MarkSpec`，与 `editor-schema` 的冻结核心集合并为唯一 Schema。

版本号与文档体**必须分层**。原始设计把 `version` 与 `type: "doc"` 放在同一层是错误的：`Node.toJSON()` 只输出 `type / attrs / content / marks`，不会输出 `version`，每次保存都要手工补回，漏一次即产生无版本文档。

```json
{
  "envelope": 1,
  "schemaVersion": 3,
  "plugins": { "table": 2, "image": 1, "link": 1 },
  "doc": {
    "type": "doc",
    "content": [
      { "type": "paragraph", "content": [{ "type": "text", "text": "示例内容" }] }
    ]
  },
  "annotations": []
}
```

| 字段 | 含义 |
| --- | --- |
| `envelope` | 信封结构自身的版本，用于将来改信封。 |
| `schemaVersion` | 平台级文档结构版本，单调递增，驱动迁移链。 |
| `plugins` | 各插件贡献结构的版本。使插件可独立升级：表格插件 v1→v2 改了单元格属性时，迁移函数据此判断该文档的 table 结构是哪一版，无需全平台锁步发版。 |
| `doc` | 纯 ProseMirror 节点 JSON，`toJSON()` 原样输出，round-trip 无损。 |
| `annotations` | 评论/批注锚点（§9.8）。存在文档外部而非文档内部。 |

### 9.2 命名空间与冻结核心集

节点名与标记名是**持久化数据契约**，落库后改名等于全量迁移。规则：

- `doc` 与 `text` 由 ProseMirror 保留（`prosemirror-model` 以 `"text"` 识别文本节点，顶层节点默认 `"doc"`），不可加前缀。
- `editor-schema` 拥有一个**冻结的、不带前缀**的核心集，永不新增、永不改名：
  `doc`、`text`、`paragraph`、`heading`、`blockquote`、`horizontal_rule`、`bullet_list`、`ordered_list`、`list_item`、`task_list`、`task_item`、`code_block`、`hard_break`、`unknown_block`、`unknown_inline`；
  标记：`strong`、`em`、`underline`、`strikethrough`、`code`。
- **其余一切由插件贡献的节点/标记必须带 `co_` 前缀**。不区分第一方与第三方——"第一方"不是稳定分类。当前已落库的名字：节点 `co_table`、`co_table_row`、`co_table_cell`、`co_table_header`、`co_image`；标记 `co_link`、`co_text_color`、`co_background_color`。规划中的 `co_mention`、`co_embed` 等沿用同一规则。
- 属性名同样带前缀或收在插件自有属性对象内。
- 以启动期校验强制：注册非冻结集且无合法前缀的名字即禁用该插件并报错。

### 9.3 未知节点兜底（防内容丢失）

严格 Schema 校验 + 插件按需安装的交点是数据丢失：一份含 `co_table` 的文档在未安装表格插件的应用中打开时，Schema 里没有该节点，`Node.fromJSON` 抛错，**整篇文档打不开**。

因此核心集内置两个兜底节点：

```ts
unknown_block: {
  group: 'block',
  atom: true,
  attrs: { original: {}, nodeName: {} },
  // 渲染为只读占位块："此内容需要 X 功能才能显示与编辑"
}
unknown_inline: { group: 'inline', inline: true, atom: true, attrs: { original: {}, nodeName: {} } }
```

规则：

1. 加载时遇到 Schema 中不存在的节点名 → 包装为 `unknown_block` / `unknown_inline`，`attrs.original` **原样保存该节点完整 JSON**（含子树）。该 JSON 必须以深拷贝存入；`getDocument()` 以只读快照交出，调用方之后修改自己传入的对象或尝试改写快照，都不得影响编辑器状态。"原样保存"的强度等于这份快照的隔离度。
2. 渲染为只读占位，可整体选中、复制、删除，不可内部编辑。
3. 保存时**原样写回原始 JSON**，`plugins` 版本号一并保留，不因途经一次编辑而降级。
4. 若同一会话中稍后安装了对应插件，重新加载即恢复为正常节点。
5. 未知标记（mark）直接丢弃标记但保留其覆盖的文本。丢弃的标记名经 `LoadResult.unknownMarks` 上报并计入 `degraded`——标记承载的属性（如链接 href）无法用兜底节点保住，只能保住文本，因此**必须让宿主知道**，否则下一次保存会静默销毁这些属性。
6. **兜底节点不带标记这一不变量必须由 runtime 维护，不能只靠 NodeSpec 的 `marks: ""`。** ProseMirror 的 `Transform.addMark` 按**父节点**的 `allowsMarkType` 判断：段落允许 `strong`，行内兜底节点就会被选区加粗一并命中，导致 DOM 上占位变粗而保存时标记又被丢弃（所见不等于所存）。实现方式是事务后清理，且该规范化事务不进用户历史。
7. `loadDocument` 返回 `LoadResult { migrated: boolean; unknownNodes: string[]; degraded: boolean }`，宿主据此提示用户"部分内容以只读形式显示"。
8. 隔离范围不止 `attrs.original`：信封的 `plugins`、`annotations`，以及已知节点的 `attrs`（ProseMirror 的 `Node.toJSON` 按引用交出活节点的 attrs），在装载与取回两侧都必须切断引用。

### 9.4 事务、状态与历史

`editor-pm-adapter` 负责创建 `EditorState` 与 `EditorView`，处理 Transaction，并转换为稳定领域事件：

当前实际派发的事件（`EditorEventName`，载荷见 `EditorEventPayload`）：

| 事件 | 载荷 | 说明 |
| --- | --- | --- |
| `change` | — | 任意状态变化，含内容与选区。订阅者用 `getSnapshot()` 区分：`revision` 只在内容变更时递增，`stateRevision` 每次都递增。 |
| `patch` | `DocumentPatch` | 增量变更（§8.4），供保存/协同/评论消费。每个内容事务一条。 |
| `compositionChanged` | `boolean` | 输入法组合态开始/结束（§9.6）。 |
| `documentDegraded` | — | 加载时出现未知节点或被丢弃的未知标记（§9.3）。 |
| `pluginError` | `PluginError` | 插件冲突降级与运行期熔断（§8.3、§8.6）。 |
| `clipboardNotice` | `ClipboardNotice` | 粘贴内容被安全或规模策略拒绝、截断（§11.4、§14.2）。 |
| `limitExceeded` | `DocumentLimitNotice` | 一次被文档规模上限挡下的写入，文档保持在被拒绝之前的状态（§14.2）。 |

四处与早期规划不同：

- **`change` 一个事件覆盖内容与选区**，而不是 `contentChanged` / `selectionChanged` 两个。UI 侧真正需要的是"状态变了，重算派生值"，而 `getSnapshot()` 的两个修订号已经把内容变更与选区变更区分开了；派两个事件只会让订阅方两边都订，然后重算两次。
- **没有 `uploadStateChanged`。** 上传态是图片插件的 plugin state + Decoration（§8.5），不是编辑器状态；把它抬到公共事件面上等于让每个宿主都要认识一个只有一个插件才关心的概念。
- **多出 `clipboardNotice`。** 粘贴被拒绝或截断必须让用户看得见，否则"降级不丢内容"这条承诺在用户眼里就是内容凭空少了一块。
- **多出 `limitExceeded`。** 同理：规模上限挡下一次写入时，用户看到的是"刚才那下没生效"。不说原因，它和一个 bug 无法区分。

业务不得直接分发 ProseMirror Transaction；所有业务操作经由命令执行。

**历史控制必须抽象。** runtime 内部事务 API 提供 `recordHistory: boolean`，而不是让插件直接写 `addToHistory` meta。程序化事务（上传回填、格式规范化、未知节点包装、远端变更）一律 `recordHistory: false`。

M1 使用 `prosemirror-history`。协同（M4）必须换成 Yjs 的 UndoManager——`prosemirror-history` 在协同下会撤销他人的编辑。这一替换的影响面被 `recordHistory` 抽象与 §7.1 的类型约束限制在 `editor-pm-adapter` 内部，**不改变 `RichEditor` 的方法签名**，因此不是业务侧破坏性变更。前置义务：在 M2 结束前完成 y-prosemirror 与本方案 Schema/NodeView 的兼容性验证（尤其表格与自定义 NodeView），避免在 M4 才发现不兼容。

### 9.5 位置映射与异步操作契约

所有跨越一次以上变更的操作遵循同一套机制：

1. 状态存在 plugin state，不存在文档。
2. plugin state 在每个事务的 `apply` 中用 `tr.mapping.map(pos)` 迁移全部持有位置。
3. 位置被删除时（`mapResult.deleted`）按功能语义决定：丢弃、标记孤儿、或收敛到删除点。
4. UI 表达用 `Decoration`，不用文档节点。
5. 回填以映射后的位置构造事务，且 `recordHistory: false`。

适用清单：图片/附件上传、AI 改写与建议、异步校验（链接可达性、敏感词）、搜索高亮、评论锚点、协同远端光标。

**任何新增的异步功能都必须说明它如何满足上述五条**，作为设计评审的准入项。

### 9.6 输入法与组合态契约

组合态（composition）是模型必须暂时让位于 DOM 的唯一时期，也是中文编辑器最主要的线上问题来源。在 `compositionstart` 与 `compositionend` 之间：

- 任何改动文档的事务都会打断组合：症状是拼音打到一半候选框消失、漏字、重复上屏。
- 任何影响当前文本节点的 Decoration 重渲染都会打断组合（拼写检查、AI 下划线、协同光标、搜索高亮均在此列）。
- 插件的 `appendTransaction` 与输入规则（如"输入 `- ` 转列表"）是最容易在组合态偷偷改文档的地方。
- Android Gboard 的 `beforeinput` / composition 行为与桌面差异极大，部分输入法不触发预期事件。

契约：

1. runtime 维护全局 `composing` 标志，通过 `SelectionSnapshot.composing` 与 `compositionChanged` 事件暴露。
2. 组合态期间：挂起所有非用户输入事务（程序化事务、远端事务、异步回填），入队；`compositionend` 后合并应用并重新映射位置。
3. 组合态期间：冻结覆盖当前文本节点的 Decoration 更新；不重建该节点的 NodeView。
4. 组合态期间：输入规则与自动格式化不执行。
5. 组合态期间调用 `execute()` 返回 `{ok:false, reason:'composing'}`，由 UI 决定禁用还是排队。
6. 兜底超时：`compositionend` 未触发（部分输入法/异常路径）时 5 秒后强制退出组合态并冲刷队列。

### 9.7 NodeView 跨框架策略

复杂节点（图片、提及、嵌入卡片）通过内核定义的 NodeView 生命周期协议表达。

框架桥接**必须使用 portal / Teleport 渲染进宿主应用的组件树**，不得为每个节点创建独立的 React root / Vue app：

- 一篇含 200 个图片/提及节点的文档会产生 200 个独立 reconciler。
- 更关键的是独立 root **完全脱离宿主 React/Vue 树，拿不到任何 context**——主题、i18n、用户 store、路由、权限全部不可用。而"@提及芯片显示用户头像"这类需求天生要访问应用状态。

实现：runtime 的 NodeViewRegistry 暴露"节点 → 宿主容器元素"的映射；`editor-react` 用 `createPortal` 将节点组件渲染进这些容器，`editor-vue` 用 `<Teleport>`。节点语义与更新逻辑在 runtime 中保持一致，两个适配层只做渲染。

### 9.8 评论锚点模型（M4 能力，M1 冻结决策）

评论**不做成 mark**，而是文档外部的锚点表，存在信封的 `annotations` 中。

理由：评论是元数据，与正文有不同的权限、生命周期与可见性；mark 会随文本分裂/合并产生 ID 去重问题，删除评论会留下残留 mark，且会污染复制粘贴与导出。

```ts
interface Annotation {
  id: string
  from: number   // M1–M3：文档扁平位置，随 DocumentPatch 映射
  to: number
  orphaned: boolean  // 锚定范围被完全删除时置位，不删除评论本体
  payload: unknown   // 评论内容由业务侧存储，编辑器只负责锚点
}
```

M4 引入 Yjs 后，`from/to` 迁移为 Y.RelativePosition；因锚点已在文档外部且已经走位置映射，该迁移不触及文档结构。

---

## 10. React / Vue 接入方案

### 10.1 挂载生命周期规则（两框架通用）

- 编辑器实例由业务创建（框架无关），通过 Provider 注入。
- 容器组件在挂载时 `editor.mount(el)`，卸载时 `editor.unmount()`，**不调用 `destroy()`**。
- `mount`/`unmount` 幂等（§8.2），必须通过 React StrictMode 双挂载测试。
- 实例销毁由创建者负责。

### 10.2 React

```tsx
<EditorProvider editor={editor}>
  <EditorToolbar />
  <EditorContent />
</EditorProvider>
```

- `EditorProvider` 注入同一个 `RichEditor` 实例；实例引用变化时重新挂载。
- `EditorContent` 在挂载后调用 `editor.mount(element)`，卸载时 `editor.unmount()`。
- `useEditorSelector(selector)` 基于 `useSyncExternalStore` + `editor.getSnapshot()`；`getSnapshot` 引用稳定（§8.1），selector 结果按值比较，避免每次事务重渲染整棵页面。
- 工具栏按钮状态来自 `useCommandQuery(cmd)` → `editor.queryCommand(cmd)`，不读文档。
- NodeView 通过 portal 渲染进当前 React 树（§9.7）。

### 10.3 Vue

```vue
<EditorProvider :editor="editor">
  <EditorToolbar />
  <EditorContent />
</EditorProvider>
```

- 使用 `shallowRef` 保存编辑器实例，避免深度响应式代理 ProseMirror 对象。
- `onMounted` → `editor.mount(el)`，`onBeforeUnmount` → `editor.unmount()`（**不是 destroy**）。
- Composable 基于 `editor.getSnapshot()` 与 `queryCommand` 提供轻量派生状态。
- NodeView 通过 `<Teleport>` 渲染进宿主应用树（§9.7）。

### 10.4 工具栏 UI 模型

工具栏的**行为**是无框架逻辑，属于 `editor-ui-model`：项与分组、启用/激活/取值计算、下拉开合规则、浮动工具栏的出现条件与定位输入、键盘 roving tabindex 顺序。

`editor-react-ui` / `editor-vue-ui` 只消费该状态机渲染 DOM。否则同一套交互在两个框架各实现一次，等于两倍缺陷面且两个 SDK 必然行为漂移——而漂移的是行为，不是外观。

---

## 11. 复制 / 粘贴设计

### 11.1 复制格式与高保真载体

复制的对象是 **Slice** 而非 Fragment：跨列表项一半、跨表格部分单元格、跨段落中部的选区需要 `openStart` / `openEnd` 开合深度，否则粘贴会产生错误嵌套（典型症状：复制列表中间两项，粘贴后变成层级错乱的列表，或段落被莫名拆开）。

| MIME 类型 | 用途 |
| --- | --- |
| `text/html` | **唯一可靠载体**。同时承载给外部应用看的语义 HTML，与给本编辑器用的高保真 payload。 |
| `text/plain` | 与纯文本应用交换及最终降级。 |
| `application/x-company-editor+json` | 可选加速通道，不可作为设计前提。 |

高保真信息写在 HTML 根元素的 `data-co-slice` 属性上：

```ts
const slice = serializeSlice(selection.content())   // { content, openStart, openEnd }
const payload = encodePayload({ v: 1, schemaVersion, plugins, slice })

clipboardData.setData(
  'text/html',
  `<div data-co-slice="${escapeAttr(payload)}">${renderSliceToHTML(slice)}</div>`,
)
clipboardData.setData('text/plain', renderSliceToPlainText(slice))
// 可选：同浏览器内的快路径
clipboardData.setData('application/x-company-editor+json', JSON.stringify(payload))
```

为什么不能依赖自定义 MIME：Safari 历史上丢弃非标准剪贴板类型；异步 Clipboard API 的 `write()` 只允许 `text/plain`、`text/html`、`image/png` 等安全列表，自定义格式需要 Chromium 专有的 `web ` 前缀；经过中间应用（粘到 Slack 再拷出）或剪贴板管理器同样会丢失。只有 `text/html` 能可靠穿透。

粘贴侧优先读取 `data-co-slice`：payload 存在且 `schemaVersion` 可迁移 → 直接还原 Slice；否则回落到普通 HTML 解析路径。

### 11.2 粘贴优先级

```text
粘贴事件
├─ 组合态中          → 拒绝（reason: 'composing'）
├─ data-co-slice     → 版本校验/迁移 → 未知节点走 §9.3 兜底 → 插入
├─ 文件或图片        → 插入空图片节点 + plugin state 占位，异步上传（§8.5）
├─ HTML              → inert 解析 → Schema 映射 → 插入（§11.3）
└─ 纯文本            → URL / TSV / 普通文本规则转换 → 插入
```

代码块内的粘贴一律走纯文本分支。

无格式粘贴：在 `keydown` 记录 `Cmd/Ctrl+Shift+V` 标志位，在随后的 `paste` 事件中只读 `text/plain`。不能"监听快捷键后主动读剪贴板"——JS 无法触发粘贴，主动读取需要异步 Clipboard API 与用户授权。

### 11.3 HTML 解析与安全边界

**安全边界是 Schema，不是 sanitizer。** 只有 Schema 能表达的结构才能进入文档，未知标签、未知属性、全部 `on*` 事件属性因"无处可去"而被构造性丢弃，而不是被"删掉"。手写 HTML sanitizer 是必输的军备竞赛（mXSS、命名空间混淆、`<svg><style>` 解析差异）。

管线：

1. **在 inert document 中解析**：`new DOMParser().parseFromString(html, 'text/html')`。该文档没有 browsing context，脚本不执行、`<img>` 不发起请求。
   **禁止**把不可信 HTML 赋给活文档中元素的 `innerHTML`——那会立即加载图片（隐私泄露、追踪像素、`onerror` 触发）。这是一行代码的差别，也是本节唯一真正的技术性安全规则。
2. 清理噪音（非安全措施，仅减少后续映射负担）：Word `mso-*` 样式、冗余 `span`、布局样式、外部 CSS 引用。
3. 按 Schema 的 `parseDOM` 规则映射为节点/标记。
4. 校验产物是否为合法文档结构；非法则按 §11.4 降级。

允许的输入结构：`p`、`br`、`strong`/`b`、`em`/`i`、`u`、`s`/`del`、`a`、`h1`~`h6`、`ul`、`ol`、`li`、`blockquote`、`pre`、`code`、`table`、`thead`、`tbody`、`tr`、`td`、`th`、`img`。

属性策略：

| 项 | 规则 |
| --- | --- |
| `td`/`th` 的 `colspan`/`rowspan` | **保留**（数值上限 1000），否则合并单元格粘贴必然错位，与 §4.2 冲突。 |
| `a[href]` | 协议白名单 `https:`、`http:`、`mailto:`、`tel:`；拒绝 `javascript:`、`data:`、`vbscript:`。相对 URL 与纯 `#fragment` 一律丢弃 href 保留文本。 |
| `a[target=_blank]` | 渲染时强制附加 `rel="noopener noreferrer"`。 |
| `img[src]` | 见 §11.3.1。 |
| 其他一切属性 | 丢弃。 |

降级规则（丢格式不丢内容）：

- `h5`/`h6` → `h4`（保留文本）。
- 未支持的块级元素 → 段落。
- 未支持的行内元素 → 保留文本，丢弃标记。
- 无法构成合法结构的片段 → 纯文本插入。

#### 11.3.1 粘贴图片的 URL 策略

外部远端图片一律**服务端转存**，不保留热链。热链的后果是隐私泄露（第三方拿到用户 IP/Referer）、防盗链失效、内网不可达、以及必然发生的链接腐烂。

转存通道的 SSRF 控制（缺一不可）：

1. 协议仅 `https:`、`http:`。
2. DNS 解析后校验目标 IP，拒绝私有网段、回环、链路本地、元数据地址（169.254.169.254 等）。
3. **不跟随重定向**（或跟随时对每一跳重复第 2 步）。
4. 响应大小上限 10MB、超时 5 秒、`Content-Type` 必须为 `image/*` 且以实际字节嗅探校验。
5. 失败则丢弃该图片并提示用户"图片需手动上传"。

`data:` URL 的图片：仅允许作为上传前的本地预览存在于 plugin state，**禁止写入文档、禁止入库**。`<img>` 中的 SVG 不执行脚本，但会把大体积 payload 存进用户文档，且一旦有别处以 `<object>`/`<iframe>` 渲染即成为 XSS 载荷。

### 11.4 特殊来源规则

- **Word**：保留标题、段落、列表、表格、链接与基础文本样式；舍弃页面布局与复杂视觉样式。
  **图片说明**：Word 放到剪贴板上的通常是 `<img src="file:///C:/Users/...">`，浏览器既取不到该文件也没有对应 blob。此类图片**一律丢弃并提示"请手动插入图片"**。不承诺"从 Word 粘贴保留图片"。
- **Excel**：优先解析剪贴板 HTML 表格（Excel 几乎总会提供；注意 `<!--StartFragment-->` 标记）。仅当无 HTML 时才按 TSV 兜底，且**必须按引号转义规则解析**——单元格内含制表符/换行时 Excel 会加引号，按 `\t`/`\n` 裸切会把一格切成多格。
- **纯文本 URL**：空选区可转链接或链接卡片；有文本选区时作为链接应用于选区。
- **`Cmd/Ctrl + Shift + V`**：强制仅文本粘贴（机制见 §11.2）。
- 超出 §14.2 阈值时拒绝或降级，并给出明确用户提示。

---

## 12. 服务端与持久化

### 12.1 渲染路径

- **服务端从 JSON 渲染，永不接受客户端提交的 HTML。** 因此主路径上不存在服务端 HTML sanitizer，也就没有"绕过客户端清洗"这一攻击面。
- `editor-schema` 是唯一渲染真理，前后端共用同一份 Schema 与 serializer，独立版本号，与文档 `schemaVersion` 对应。
- 因 §7.1 约束 `toDOM` 只返回 `DOMOutputSpec` 数组、不触碰 `document`，可用纯 JS walker 把 DOMOutputSpec 序列化为 HTML 字符串：服务端**不需要 jsdom**，且该 spec 可导出为数据供其他语言实现渲染。
- 若某条历史链路确实会收到外部 HTML，须先经 §11.3 管线转为 JSON 再入库，不得直接存储。

### 12.2 版本迁移

- 迁移链按 `schemaVersion` 单调递增，每一步一个纯函数 `(envelope) => envelope`，可测试、可回放。
- 插件拥有的节点由该插件的 `registerMigrations` 处理，依据信封 `plugins[name]` 版本判断起点。
- 迁移在读取时执行；写回时更新 `schemaVersion` 与 `plugins`。
- 未知节点（§9.3）在迁移中原样透传，绝不参与结构改写。
- 每个迁移步骤必须提供反向函数或明确标注不可逆，并配备真实文档样本的回归用例。

### 12.3 保存

- 增量保存基于 `DocumentPatch`（§8.4）+ `revision` 乐观并发：服务端校验 `patch.from === 当前 revision`，不匹配则拒绝并要求客户端重放。
- 全量保存作为兜底与定期快照。
- 自动保存节流：内容变更后 2 秒空闲或累计 50 次变更触发，取先到者。

---

## 13. 安全要求

- 客户端与服务端在渲染/落库前均执行 Schema 与内容安全校验；服务端不信任任何客户端产物。
- 不可信 HTML 只在 inert document 中解析（§11.3 第 1 条）。
- URL 协议白名单；外链强制 `rel="noopener noreferrer"`。
- 粘贴图片转存的 SSRF 控制（§11.3.1）。
- 图片上传校验 MIME（按实际字节嗅探，不信 `File.type`）、大小、数量；服务端返回对象存储 URL，不信任客户端提交的 URL。
- 插件配置运行时校验；插件异常按 §8.6 熔断，不得破坏主编辑器或丢失内容。
- `unknown_block` 的 `attrs.original` 是未经解释的外部数据，渲染时**只能作为只读占位**，不得递归渲染其内容。
- 文档与 patch 的大小/节点数上限在服务端同样校验（§14.2），不依赖客户端限流。

---

## 14. 性能预算与规模上限

没有数字的性能要求不可证伪，等于风险未被缓解。当前门禁使用的是初始阈值，不是已采集的 CI 历史基线；拿到真实业务样本和连续 CI 数据后必须校准。

### 14.1 基准与预算

基准文档：5 万字 / 300 段 / 50 图 / 20 表 / 最深 4 层列表。

| 指标 | 预算 |
| --- | --- |
| 编辑器挂载（`loadDocument` 到 `mount` 完成） | < 1200ms |
| 格式化后的 DOM 状态更新 p95（jsdom） | < 240ms |
| 解析 1 万字 HTML（jsdom） | < 1200ms |
| 工具栏状态更新 | < 96ms |
| 装载、读 JSON 与渲染 HTML 的堆内存增量 | < 96MB |

已交付的手段是细粒度框架订阅（§10.2）与 `getDocument()` 状态缓存。字数统计增量维护、真实浏览器重绘测量及 NodeView 懒挂载在相应能力引入时补齐，不能被本门禁视为已验证。

### 14.2 硬上限

| 项 | 上限 | 超出行为 | 执行点 |
| --- | --- | --- | --- |
| 文档节点数 | 20,000 | 拒绝插入并提示 | `EditorSession` 的唯一事务入口，发 `limitExceeded` |
| 文档 JSON 大小 | 2MB | 拒绝保存并提示 | **宿主**，保存前用 `getDocumentSize()` 判定 |
| 单次粘贴 HTML 大小 | 2MB | 截断并提示，或降级纯文本 | 剪贴板管线，发 `clipboardNotice: html-too-large` |
| 单次粘贴文件数 | 20 | 超出部分忽略并提示 | 剪贴板管线，发 `clipboardNotice: file-limit` |
| 单图大小 | 10MB | 拒绝并提示 | 剪贴板管线，发 `clipboardNotice: image-too-large` |
| 表格单表单元格数 | 5,000 | 粘贴降级为纯文本并提示；插入直接拒绝 | 粘贴侧发 `clipboardNotice: table-limit`；`table.insert` 返回 `ok:false` |
| `colspan`/`rowspan` 数值 | 1,000 | 钳制 | 外部 HTML 解析时钳制，不提示 |

节点数与字节数的执行点刻意不同：节点数是编辑器能拦的，放在唯一事务入口，打字、粘贴、拖入、插件回填因此受同一条规则约束；字节数是宿主才能拦的，保存是宿主的动作，编辑器无从代它拒绝，只能给出可判定的事实。

**两者都只拦新写入，不拦装载。** 已经超限的历史文档必须打得开，否则超限本身就成了丢内容的方式——这与 §9.3 对缺插件的立场是同一条。

节点计数落在按键路径上，因此不做全文遍历：会话维护一个只增的保守上界，每个事务加上它写入的节点数，只有上界触到硬上限时才精确重算一次并把上界收回真实值。打字是 O(1)。

---

## 15. 可访问性要求

- 全部编辑与格式操作可纯键盘完成；快捷键可查询、可展示。
- 工具栏按 ARIA `toolbar` 模式实现：roving tabindex，方向键在项间移动，Tab 进出整个工具栏（行为由 `editor-ui-model` 统一提供）。
- 浮动工具栏与弹层：焦点可达、`Esc` 关闭且焦点返回原位、不做焦点陷阱以外的强制聚焦。
- 表格键盘导航：方向键跨单元格、`Tab` 到下一单元格、行末 `Tab` 新增行。
- 编辑区具备可访问名称与角色；只读态与禁用态语义正确暴露（只读不是禁用）。
- 图片必须可填 `alt`；上传中/失败状态通过 `aria-live` 通知。
- `unknown_block` 占位块提供说明性文本而非空白。
- 视觉：对比度符合 WCAG AA；不以颜色作为唯一状态区分。

---

## 16. 验收标准

### 16.1 功能验收

以下是目标版本验收项；当前完成状态以 `docs/implementation-slices.md` 的“当前交付状态”为准。

- React 可加载同一份信封 JSON 文档，并编辑、保存、重新打开；Vue 对等验收在 S18 的接入方与时间确定后执行。
- 基础格式、列表、表格、图片、链接支持撤销重做。
- 编辑器内部复制粘贴不丢失支持范围内的结构和语义，**包括跨列表项一半、跨表格部分单元格、跨段落中部的选区**。
- 从 Word、网页、Excel 粘贴时保留约定语义，且不引入多余页面样式（以 §16.5 golden diff 判定）。
- 无格式粘贴、图片粘贴、上传失败重试可用。
- 合并单元格（`colspan`/`rowspan`）经复制粘贴后结构不变。
- Excel 中含制表符/换行的单元格粘贴后不被拆格。

### 16.2 数据安全验收（防丢失）

- **缺插件不丢内容**：含 `co_table` 的文档在未安装表格插件的实例中打开 → 显示只读占位 → 编辑其他内容并保存 → 用完整环境重新打开，表格结构与内容完全一致。
- **undo 不回退上传**：图片上传成功后按一次 undo，不得回到 loading 态。
- **撤销后上传成功不产生孤儿**：上传中撤销删除图片，上传完成时调用 `discard`，对象存储无孤儿文件。
- **复制上传中节点**不产生重复 `uploadId`。
- 迁移链对全部真实文档样本可正向执行，标注可逆的步骤可反向执行。

### 16.3 安全验收

- 粘贴含脚本、事件属性、`javascript:` URL 的 HTML 不执行脚本、不生成危险链接。
- 粘贴含追踪像素的 HTML 时，**解析阶段不产生任何网络请求**（以 devtools/网络断言验证 inert 解析）。
- 非法 JSON、超限内容无法写入；未知节点转为只读占位而非报错。
- 图片转存通道拒绝私有网段、拒绝重定向到内网、拒绝非图片 Content-Type。
- 服务端渲染输出通过安全扫描测试。

### 16.4 输入法与中文验收

- 输入法矩阵：macOS 拼音、Windows 微软拼音、Android Gboard、iOS 拼音。每种至少覆盖：
  - 组合态中触发输入规则（如行首输入 `- `）不断字、不漏字；
  - 组合态中收到异步/程序化事务（模拟上传回填）不打断组合；
  - 组合态中 Decoration 更新被冻结。
- 智能标点默认关闭，中文引号不被改写。
- 字数统计对 CJK、emoji、组合字符计数正确（待公开字数统计能力落地后验收）。

### 16.5 工程验收

- 核心包不依赖 React/Vue；`editor-schema` 不依赖 DOM（以依赖检查 lint 在 CI 强制）。
- 新增一个能力插件无需修改 Core 私有实现：CI 内置一个只使用公开 API 的样例插件作为一致性测试。
- 公开 API 表面快照（API Extractor 类工具）纳入 CI，意外泄漏 ProseMirror 类型即失败。
- 插件依赖冲突、命令冲突、Schema 冲突具备可诊断错误，且**不导致启动失败**。
- 节点名命名空间 lint：注册非冻结集且无 `co_` 前缀的名字即失败。
- `toDOM` 不触碰 `document` 的静态检查 + 服务端渲染单测。
- React StrictMode 双挂载不报错、内容不丢。
- **剪贴板 golden 语料库**：`fixtures/clipboard/` 保存从真实 Word / Excel / 网页 / 飞书 / Notion / 微信公众号 / Google Docs 复制出的**原始剪贴板 dump（三种 MIME 全存）** + 对应黄金 JSON 输出，附重录命令。粘贴逻辑每次改动跑全量 golden diff。这是唯一能防住"修了 Word 又坏了 Notion"的机制。
- 性能基准（§14.1）纳入 CI，超预算 20% 即失败。
- a11y 自动检查（axe 类）+ 键盘走查清单。

---

## 17. 实施计划

排序原则：把声称最核心、最不可逆的部分放在最前；可推迟且推迟成本为零的部分往后放。

| 阶段 | 范围 | 主要产出 |
| --- | --- | --- |
| **M1：内核与不可逆决策** | PM Adapter、`editor-schema` 与冻结核心集、信封 JSON 与命名空间、`unknown_block` 兜底、位置映射与异步契约、组合态契约、`DocumentPatch`、基础块与命令、历史抽象、**内部复制粘贴最小闭环（`text/html` 承载 Slice）**、剪贴板 golden 语料库骨架、React 容器与 UI 模型 | 可编辑、可存储、可增量保存、缺插件不丢内容、输入法稳定的最小版本；§19 十项决策全部落地 |
| **M2：内容能力与第二框架** | 表格、图片与上传、链接、代码块、完整粘贴管线（Word/Excel/网页）、服务端渲染路径、Vue 适配层、y-prosemirror 兼容性验证 | 覆盖主要内容生产场景；双框架接入 |
| **M3：平台化** | 插件依赖治理与熔断、迁移链与回归样本、UI Contract、a11y 达标、性能基准与监控 | 可持续扩展的编辑器平台 |
| **M4：高级能力** | Yjs 协同（含 UndoManager 替换）、评论（消费 §9.8 锚点）、版本历史（消费 patch 流）、AI 能力 | 多人及智能化编辑体验 |

M1 的交付物包含决策文档：§19 的十项冻结决定必须有明确结论并落到代码，而不是留待后续。

---

## 18. 风险与应对

| 风险 | 应对 |
| --- | --- |
| Word/网页格式差异巨大 | 明确"保留语义、舍弃视觉噪声"边界；剪贴板 golden 语料库回归（§16.5）。 |
| 插件与文档版本锁步，独立升级失效 | 信封记录 per-plugin 版本；插件自持迁移函数（§9.1、§12.2）。 |
| 缺插件/旧插件导致用户内容丢失 | `unknown_block` 原样透传 + 专项验收（§9.3、§16.2）。 |
| 位置映射缺失导致异步功能不可靠（图片错位、评论飘移、AI 改写打错位置） | 统一异步契约（§9.5）并作为新功能设计评审准入项。 |
| 输入法场景断字漏字 | 组合态契约（§9.6）+ 真实输入法矩阵验收（§16.4）。 |
| 插件间 Schema/命令冲突 | 命名空间、拓扑排序、启动期校验、冲突降级而非启动失败（§8.3）。 |
| 单个插件异常拖垮编辑器 | 入口包裹 + 熔断 + 视图重建（§8.6）。 |
| 大文档性能下降 | 明确预算与硬上限并纳入 CI（§14）。 |
| 前后端渲染结果漂移 | 单一 `editor-schema` 包 + `toDOM` 无 DOM 依赖约束（§12.1）。 |
| M4 协同引入时基础件被迫替换 | 历史控制抽象在 `recordHistory` 之后；M2 内完成 y-prosemirror 兼容性验证（§9.4）。 |
| 双框架实现行为漂移 | 行为收敛到 `editor-ui-model`；Vue 适配层后移（§10.4、§17）。 |
| 外部内容带来安全问题 | Schema 即白名单、inert 解析、URL 协议白名单、转存 SSRF 控制（§11.3、§13）。 |

---

## 19. M1 前必须冻结的决定（均不可逆或返工代价高）

| # | 决定 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | 文档 JSON 结构与版本策略 | `{envelope, schemaVersion, plugins, doc, annotations}` 信封；version 与 doc 分层 | §9.1 |
| 2 | 节点名/标记名命名空间 | 冻结核心集不带前缀；插件贡献一律 `co_` 前缀；命令名用插件名做前缀即可 | §9.2、§8.3 |
| 3 | 缺插件时的兜底行为 | `unknown_block` / `unknown_inline` 原样保存并只读占位，保存时原样写回 | §9.3 |
| 4 | 增量变更格式 | 平台自有 `DocumentPatch v1`，M1 即产出，仅对平台与服务端开放 | §8.4 |
| 5 | 撤销实现 | M1 用 `prosemirror-history`，但历史控制抽象为 `recordHistory`；M4 换 Yjs UndoManager，影响面限于 adapter；M2 内完成兼容性验证 | §9.4 |
| 6 | 评论锚点模型 | 文档外部锚点表（信封 `annotations`），不做 mark；M4 迁移为 Y.RelativePosition | §9.8 |
| 7 | 异步操作位置契约 | plugin state + `mapping.map` + Decoration + `recordHistory:false`；上传态不进文档 | §9.5、§8.5 |
| 8 | 粘贴图片 URL 策略 | 服务端转存 + SSRF 控制；不热链；`data:` 仅作预览不入库 | §11.3.1 |
| 9 | 服务端渲染路径 | 共用 `editor-schema`；`toDOM` 禁触 `document`；服务端不接受客户端 HTML | §12.1、§7.1 |
| 10 | Vue 适配层时间点 | 排在 M2；需业务方确认实际接入方与时间，否则不提前 | §3、§17 |
