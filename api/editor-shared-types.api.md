# editor-shared-types

```ts
interface Annotation {
  id: string;
  from: number;
  to: number;
  orphaned: boolean;
  payload: unknown;
}
```

```ts
interface ClipboardNotice {
  code: "html-too-large" | "file-limit" | "image-too-large" | "word-file-image" | "table-limit";
  message: string;
}
```

```ts
interface CollabPeer extends CollabPeerIdentity {
  /** 会话内唯一，取自 Yjs 的 clientID。断线重连后会变。 */
  id: number;
  local: boolean;
}
```

```ts
interface CollabPeerIdentity {
  name: string;
  /** 光标与选区的颜色，十六进制。 */
  color: string;
}
```

```ts
interface CollabRejection {
  code: "schema-incompatible";
  /** 共享文档里本端 Schema 不认识的节点名，按出现顺序去重。 */
  unknownNodes: string[];
  /** 同上，标记名。标记不会触发删除，但同样意味着本端表达不全。 */
  unknownMarks: string[];
  message: string;
}
```

```ts
interface CollabState {
  enabled: boolean;
  status: CollabStatus;
  /**
   * 是否已绑定共享文档。为 false 时编辑的是本地文档，改动不会同步——
   * 连接中、以及被拒绝后，都处于这个状态。
   */
  bound: boolean;
  rejection?: CollabRejection;
  /** 含本端自己，按 `id` 升序。 */
  peers: readonly CollabPeer[];
}
```

```ts
type CollabStatus = "disconnected" | "connecting" | "connected" | "synced";
```

```ts
type CommandFailureReason =
  | "disabled"
  | "destroyed"
  | "invalid"
  | "pluginError"
  | "composing";
```

```ts
interface CommandQuery {
  enabled: boolean;
  /** 选区当前是否整体处于该命令的生效状态。 */
  active: boolean;
}
```

```ts
interface CommandResult {
  ok: boolean;
  reason?: CommandFailureReason;
  detail?: unknown;
}
```

```ts
interface CoreAttrSpec {
  default?: unknown;
}
```

```ts
interface CoreDOMAttributeRule {
  attribute: string;
  /**
   * `token` 只接受标识符字符（首位字母，其余 `a-z0-9+#._-`，最长 32），
   * 用于取值开放、枚举不完的属性：语言名一类的值会进 `class`，放行任意
   * 字符串等于让文档内容决定标签结构。
   */
  type?: "integer" | "token";
  min?: number;
  max?: number;
  /**
   * `token` 专用：属性值按空白拆成列表，取第一个带此前缀的项并去掉前缀。
   * `class="highlight language-ts"` 因此读作 `ts`。
   */
  prefix?: string;
  /**
   * 取值白名单。DOM 上的字符串会被原样写进文档属性，再由 `toDOM` 拼进 HTML；
   * 少了白名单，一份手写的 `data-align="x;background:url(…)"` 就能顺着解析
   * 管线走进内联样式。不在名单内的值回落到 `default`。
   */
  oneOf?: readonly string[];
  default?: unknown;
}
```

```ts
interface CoreMarkdownAttributeRule {
  /** `attribute` 读 token 的 HTML 属性，`info` 读围栏语言串。 */
  from: "attribute" | "info";
  attribute?: string;
  /**
   * `token` 与 `CoreDOMAttributeRule` 同一套标识符字符集；`url` 按 `protocols`
   * 白名单校验并归一化——Markdown 文件同样是不可信来源，一个
   * `[x](javascript:…)` 不该在文档里留下可执行的 href。
   */
  type?: "integer" | "token" | "boolean" | "url" | "string";
  /** `url` 专用协议白名单，例如 `["https:", "http:"]`。缺省则拒绝一切 URL。 */
  protocols?: readonly string[];
  min?: number;
  max?: number;
  oneOf?: readonly string[];
  default?: unknown;
}
```

```ts
interface CoreMarkdownNodeView {
  attrs: Record<string, unknown>;
  content: readonly NodeJSON[];
}
```

```ts
interface CoreMarkdownParseRule {
  /** markdown-it 的 token 类型。成对 token 写去掉 `_open` 的名字，如 `heading`。 */
  token: string;
  /** 进一步按 token 的标签名区分，用于 `h1`–`h6` 这种同类型多标签的情况。 */
  tag?: string;
  /** 命中时写入的固定属性。 */
  attrs?: Record<string, unknown>;
  /** 从 token 上声明式读取的属性。 */
  attrsFromToken?: Record<string, CoreMarkdownAttributeRule>;
}
```

```ts
interface CoreMarkSpec {
  attrs?: Record<string, CoreAttrSpec>;
  parseDOM?: CoreParseRule[];
  toDOM?: (mark: CoreMarkView) => DomOutputSpec;
  toMarkdown?: CoreMarkToMarkdown;
  fromMarkdown?: CoreMarkdownParseRule[];
  /**
   * 标记内的文本是字面量，序列化时不做 Markdown 转义。行内代码就是这一类：
   * 代码跨里没有反斜杠转义，`` `a \` b` `` 里的反斜杠是代码的一部分。
   */
  markdownLiteral?: boolean;
}
```

```ts
type CoreMarkToMarkdown = (mark: CoreMarkView, content: string) => string;
```

```ts
interface CoreMarkView {
  attrs: Record<string, unknown>;
}
```

```ts
interface CoreNodeSpec {
  content?: string;
  group?: string;
  inline?: boolean;
  atom?: boolean;
  marks?: string;
  /** 内容按代码处理：不做智能替换，粘贴一律纯文本。 */
  code?: boolean;
  /** 保留原样空白，配合 `code` 使用。 */
  whitespace?: "pre" | "normal";
  /**
   * 有自身语义、不该在替换内容时被顺手拆掉的块（标题、列表项、代码块）。
   * 少了它，往标题里粘一段带结构的内容会把标题本身弄没。
   */
  defining?: boolean;
  /** 表格等结构在替换时不能从边界穿透。 */
  isolating?: boolean;
  /** prosemirror-tables 用于识别 table / row / cell / header_cell。 */
  tableRole?: "table" | "row" | "cell" | "header_cell";
  selectable?: boolean;
  attrs?: Record<string, CoreAttrSpec>;
  parseDOM?: CoreTagParseRule[];
  toDOM?: (node: CoreNodeView) => DomOutputSpec;
  /**
   * Markdown 表达。和 `toDOM`/`parseDOM` 放在一起而不是集中到 Markdown 包里：
   * 节点的每一种表达都该跟着节点定义走，否则新增一个节点要改两个包，
   * 而漏改的那一个不会有任何报错（方案 §4.3）。缺省即"Markdown 表达不了"，
   * 由序列化器按丢格式不丢内容降级。
   */
  toMarkdown?: CoreNodeToMarkdown;
  fromMarkdown?: CoreMarkdownParseRule[];
}
```

```ts
type CoreNodeToMarkdown = (
  node: CoreMarkdownNodeView,
  context: MarkdownSerializeContext,
) => string;
```

```ts
interface CoreNodeView {
  attrs: Record<string, unknown>;
}
```

```ts
type CoreParseRule = CoreTagParseRule | CoreStyleParseRule;
```

```ts
interface CoreStyleParseRule {
  style: string;
  priority?: number;
}
```

```ts
interface CoreTagParseRule {
  tag: string;
  priority?: number;
  /**
   * 该规则命中时写入的固定属性，例如 `h2` → `{ level: 2 }`。
   * 刻意只支持常量而不是 `getAttrs` 函数：解析规则要能在服务端复用，
   * 也要能被审计——一个能跑任意代码的钩子两样都做不到。
   */
  attrs?: Record<string, unknown>;
  /**
   * 从已由上层白名单化的 DOM 读取属性。映射是声明式的，避免把可执行的
   * `getAttrs` 钩子泄漏到可共享的 Schema 定义中。
   */
  attrsFromDOM?: Record<string, string | CoreDOMAttributeRule>;
  /** 代码块等需要保留原样空白的节点。 */
  preserveWhitespace?: boolean | "full";
}
```

```ts
DOCUMENT_JSON_LIMIT_BYTES: number
```

```ts
DOCUMENT_NODE_LIMIT: 20000
```

```ts
interface DocumentLimitNotice {
  code: "document-node-limit";
  limit: number;
  /** 若不拒绝，文档会达到的规模。 */
  actual: number;
  message: string;
}
```

```ts
interface DocumentMigration {
  /** 本步把文档升级到这个 schemaVersion。 */
  to: number;
  up(envelope: EditorEnvelope): EditorEnvelope;
  down?(envelope: EditorEnvelope): EditorEnvelope;
  irreversible?: true;
}
```

```ts
interface DocumentPatch {
  v: 1;
  from: number;
  to: number;
  ops: PatchOp[];
  inverse: PatchOp[];
}
```

```ts
interface DocumentTextStats {
  /** 全部字符。emoji 与组合字符按用户看到的一个字形计一个。 */
  characters: number;
  /** 不含空白字符的口径。 */
  charactersWithoutWhitespace: number;
}
```

```ts
type DomOutputSpec = string | readonly [string, ...DomOutputSpecChild[]];
```

```ts
type DomOutputSpecChild = DomOutputSpec | Record<string, string> | 0;
```

```ts
interface EditorEnvelope {
  envelope: number;
  schemaVersion: number;
  /** 各插件贡献结构的版本，使插件可独立升级。 */
  plugins: Record<string, number>;
  doc: NodeJSON;
  annotations: Annotation[];
}
```

```ts
type EditorEventName =
  | "change"
  | "compositionChanged"
  | "documentDegraded"
  | "limitExceeded"
  | "patch"
  | "pluginError"
  | "clipboardNotice"
  | "collabChanged"
  | "collabRejected";
```

```ts
interface EditorEventPayload {
  change: undefined;
  compositionChanged: boolean;
  documentDegraded: undefined;
  /** 一次被规模上限拒绝的写入。文档保持在被拒绝之前的状态。 */
  limitExceeded: DocumentLimitNotice;
  pluginError: PluginError;
  clipboardNotice: ClipboardNotice;
  /** 每个内容事务一条，可用于增量保存、协同和版本历史。 */
  patch: DocumentPatch;
  /** 连接状态、绑定状态或在线协作者发生变化。 */
  collabChanged: CollabState;
  /** 本端 Schema 与共享文档不兼容，已放弃接入。文档仍是本地那一份。 */
  collabRejected: CollabRejection;
}
```

```ts
type EditorMode = "edit" | "readonly" | "disabled";
```

```ts
interface EditorSnapshot {
  /** 文档修订号，仅内容变更时递增；用于乐观并发与增量保存。 */
  revision: number;
  /** 任意状态变更（含选区）都递增；供 UI 订阅使用。 */
  stateRevision: number;
  dirty: boolean;
  mounted: boolean;
  mode: EditorMode;
  /** 输入法组合期间模型让位给 DOM，命令和非用户事务会被暂缓。 */
  composing: boolean;
}
```

```ts
interface LoadResult {
  ok: boolean;
  /** 输入是否被迁移到当前信封/结构版本。 */
  migrated: boolean;
  /** 是否有内容被降级为只读兜底节点。宿主据此提示用户。 */
  degraded: boolean;
  /** 被兜底的节点名，按文档顺序去重。 */
  unknownNodes: string[];
  /** 被丢弃的未知标记名：文本保留、格式丢失，宿主应据此提示。 */
  unknownMarks: string[];
  errors?: string[];
}
```

```ts
interface MarkdownDegrade {
  kind: MarkdownDegradeKind;
  /** 涉及的具体项：节点名、URL 或原始文本片段。 */
  item?: string;
  count: number;
  message: string;
}
```

```ts
type MarkdownDegradeKind =
  /** 图片按链接落地：远端图片一律先服务端转存，不能直接进文档（方案 §11.3.1）。 */
  | "image-as-link"
  /** 链接协议不在白名单内，标记被丢弃、文本保留。 */
  | "unsafe-link"
  /** 目标节点所属插件未安装，结构降级为段落。 */
  | "missing-plugin";
```

```ts
interface MarkdownImportResult {
  doc: NodeJSON;
  /** 按 `kind` + `item` 归并后的降级记录，按首次出现顺序。 */
  degrades: MarkdownDegrade[];
}
```

```ts
interface MarkdownSerializeContext {
  /** 渲染一个子块，返回不带首尾空行的片段。 */
  block(node: NodeJSON): string;
  /** 渲染一组子块，块之间空一行。 */
  blocks(nodes: readonly NodeJSON[]): string;
  /** 渲染行内内容，包含其上的标记。 */
  inline(nodes: readonly NodeJSON[]): string;
  /** 逐行加前缀。首行前缀可不同，用于列表项的"标记 + 悬挂缩进"。 */
  prefixLines(text: string, firstPrefix: string, restPrefix?: string): string;
  /** 转义会被 Markdown 当成结构的字符。 */
  escapeText(value: string): string;
}
```

```ts
interface MarkJSON {
  type: string;
  attrs?: Record<string, unknown>;
}
```

```ts
interface NodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NodeJSON[];
  marks?: MarkJSON[];
  text?: string;
}
```

```ts
type PatchOp =
  | { type: "replace"; from: number; to: number; slice: SliceJSON }
  | { type: "attr"; pos: number; attrs: Record<string, unknown> }
  | { type: "mark"; from: number; to: number; mark: MarkJSON; add: boolean };
```

```ts
interface PluginError {
  /** 被降级的插件名。 */
  plugin: string;
  kind: PluginErrorKind;
  /** 冲突的具体项：节点名、标记名、命令名或依赖名。 */
  item?: string;
  /** 冲突对方：先注册者的插件名，或 `core` 表示冻结核心集。 */
  conflictWith?: string;
  /** 该插件的能力当前是否整体不可用。重复命令名只丢一条命令，此处为 false。 */
  disabled: boolean;
  /**
   * 本会话内是否不再恢复。启动期的冲突禁用即为 true；运行期抛错在达到熔断阈值
   * （60 秒内 3 次）前为 false——下一次调用还会再试一次（方案 §8.6 第 3 条）。
   */
  tripped: boolean;
  /** 面向宿主的可读描述，可直接展示。 */
  message: string;
}
```

```ts
type PluginErrorKind =
  /** 依赖成环，环上插件全部禁用。 */
  | "cycle"
  /** 依赖不存在，或依赖的插件已被禁用（递归禁用）。 */
  | "missingDependency"
  /** 插件重名，后注册者禁用。 */
  | "duplicatePlugin"
  /** 节点名/标记名与核心集或先注册者冲突，后注册者禁用。 */
  | "duplicateNode"
  | "duplicateMark"
  /** 命令名与核心命令或先注册者冲突，只忽略这一条命令。 */
  | "duplicateCommand"
  /** 名字本身非法：持久化名缺 `co_` 前缀，或命令名没有以插件名打头。 */
  | "invalidName"
  /** 插件入口点抛错，被 runtime 捕获（方案 §8.6）。 */
  | "runtimeError";
```

```ts
interface SelectionSnapshot {
  empty: boolean;
  marks: string[];
  blockType: string;
  path: string[];
  composing: boolean;
}
```

```ts
interface SliceJSON {
  content: NodeJSON[];
  openStart: number;
  openEnd: number;
}
```

```ts
interface VersionLog {
  v: 1;
  /** 基线文档与它的修订号。日志只能回答基线之后的版本。 */
  baseRevision: number;
  baseDoc: NodeJSON;
  entries: VersionLogEntry[];
}
```

```ts
interface VersionLogEntry {
  patch: DocumentPatch;
  /** 宿主的版本元数据（时间、作者、标签）。编辑器不生成也不解释它。 */
  meta?: unknown;
}
```
