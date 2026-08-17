/**
 * 平台共享类型。不依赖 ProseMirror、DOM 或任何框架。
 */

/** 文档节点的持久化形态。 */
export interface NodeJSON {
  type: string;
  attrs?: Record<string, unknown>;
  content?: NodeJSON[];
  marks?: MarkJSON[];
  text?: string;
}

export interface MarkJSON {
  type: string;
  attrs?: Record<string, unknown>;
}

/** ProseMirror Slice 的平台自有 JSON 形态，不泄漏运行时对象。 */
export interface SliceJSON {
  content: NodeJSON[];
  openStart: number;
  openEnd: number;
}

/**
 * 可持久化、可重放的文档增量。`v` 与文档的 schemaVersion 独立演进。
 * 位置沿用 ProseMirror 的文档扁平位置语义；这是服务端和客户端共享的契约。
 */
export interface DocumentPatch {
  v: 1;
  from: number;
  to: number;
  ops: PatchOp[];
  inverse: PatchOp[];
}

export type PatchOp =
  | { type: "replace"; from: number; to: number; slice: SliceJSON }
  | { type: "attr"; pos: number; attrs: Record<string, unknown> }
  | { type: "mark"; from: number; to: number; mark: MarkJSON; add: boolean };

/**
 * 评论/批注锚点。存在文档外部而非文档内部（方案 §9.8）。
 * S1 只定型字段，锚点映射由后续切片实现。
 */
export interface Annotation {
  id: string;
  from: number;
  to: number;
  orphaned: boolean;
  payload: unknown;
}

/**
 * 文档信封：版本号与文档体分层，使 `doc` 保持为纯节点 JSON，
 * 序列化 round-trip 不丢字段（方案 §9.1）。
 */
export interface EditorEnvelope {
  envelope: number;
  schemaVersion: number;
  /** 各插件贡献结构的版本，使插件可独立升级。 */
  plugins: Record<string, number>;
  doc: NodeJSON;
  annotations: Annotation[];
}

/**
 * 一步文档结构迁移。由平台或插件提供，按 `to` 从小到大依次执行（方案 §12.2）。
 * 每步必须提供 `down` 或显式标注 `irreversible`。
 */
export interface DocumentMigration {
  /** 本步把文档升级到这个 schemaVersion。 */
  to: number;
  up(envelope: EditorEnvelope): EditorEnvelope;
  down?(envelope: EditorEnvelope): EditorEnvelope;
  irreversible?: true;
}

export interface LoadResult {
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

/**
 * Markdown 导入的降级记录。Markdown 是交换格式不是存储格式，凡是它表达不了
 * 或不该原样接受的结构都在这里留痕，宿主据此提示用户，而不是让内容静悄悄变样
 * （方案 §4.3）。
 */
export type MarkdownDegradeKind =
  /** 图片按链接落地：远端图片一律先服务端转存，不能直接进文档（方案 §11.3.1）。 */
  | "image-as-link"
  /** 链接协议不在白名单内，标记被丢弃、文本保留。 */
  | "unsafe-link"
  /** 目标节点所属插件未安装，结构降级为段落。 */
  | "missing-plugin";

export interface MarkdownDegrade {
  kind: MarkdownDegradeKind;
  /** 涉及的具体项：节点名、URL 或原始文本片段。 */
  item?: string;
  count: number;
  message: string;
}

export interface MarkdownImportResult {
  doc: NodeJSON;
  /** 按 `kind` + `item` 归并后的降级记录，按首次出现顺序。 */
  degrades: MarkdownDegrade[];
}

/**
 * 文档字数。两个口径都按 Unicode 字符计，CJK 一个字算一个字符；
 * 刻意不提供按空格分词的 word count——中文里那个数字没有意义（方案 §4.4）。
 */
export interface DocumentTextStats {
  /** 全部字符。emoji 与组合字符按用户看到的一个字形计一个。 */
  characters: number;
  /** 不含空白字符的口径。 */
  charactersWithoutWhitespace: number;
}

/** 命令失败原因可判别，便于线上定位（方案 §8.1）。 */
export type CommandFailureReason =
  | "disabled"
  | "destroyed"
  | "invalid"
  | "pluginError"
  | "composing";

export interface CommandResult {
  ok: boolean;
  reason?: CommandFailureReason;
  detail?: unknown;
}

export interface CommandQuery {
  enabled: boolean;
  /** 选区当前是否整体处于该命令的生效状态。 */
  active: boolean;
}

/**
 * 供工具栏判断上下文的轻量选区快照，不暴露 ProseMirror 的可变状态对象。
 * 组合态是 DOM 接管模型的短暂窗口，宿主应据此暂停会改写文档的交互。
 */
export interface SelectionSnapshot {
  empty: boolean;
  marks: string[];
  blockType: string;
  path: string[];
  composing: boolean;
}

/**
 * 插件降级的原因。每一类都要能定位到"谁、因为什么、和谁冲突"，
 * 否则线上只能看到功能消失（方案 §8.3）。
 */
export type PluginErrorKind =
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

/**
 * 一次插件降级记录。启动期冲突与运行期熔断共用同一形态，
 * 宿主只需要一处上报与一处提示。
 */
export interface PluginError {
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

/**
 * 文档规模硬上限（方案 §14.2）。两条上限的执行点刻意不同：
 *
 * - 节点数由会话在唯一事务入口把关，任何来源的插入都受同一条规则约束；
 * - 字节数由宿主在保存前用 `getDocumentSize()` 把关——保存是宿主的动作，
 *   编辑器无从代它拒绝，只能给出可判定的事实。
 *
 * 两者都只拦"新写入"，不拦装载：已经超限的历史文档必须打得开，否则超限
 * 本身就成了丢内容的方式。
 */
export const DOCUMENT_NODE_LIMIT = 20_000;
export const DOCUMENT_JSON_LIMIT_BYTES = 2 * 1024 * 1024;

/** 文档规模超限被拒绝时发给宿主的可展示提示。 */
export interface DocumentLimitNotice {
  code: "document-node-limit";
  limit: number;
  /** 若不拒绝，文档会达到的规模。 */
  actual: number;
  message: string;
}

/** 剪贴板内容被安全或规模策略拒绝、截断时发给宿主的可展示提示。 */
export interface ClipboardNotice {
  code: "html-too-large" | "file-limit" | "image-too-large" | "word-file-image" | "table-limit";
  message: string;
}

/**
 * 协同连接状态（方案 §17、§19 第 5 条）。
 *
 * `connected` 与 `synced` 必须分开：连上了但还没收到对方的完整状态时，本端看到的
 * 文档是不完整的，此刻绑定共享文档等于拿一份残缺内容去和别人对齐。
 */
export type CollabStatus = "disconnected" | "connecting" | "connected" | "synced";

/** 协作者的可见身份。宿主提供，编辑器只负责广播与渲染。 */
export interface CollabPeerIdentity {
  name: string;
  /** 光标与选区的颜色，十六进制。 */
  color: string;
}

export interface CollabPeer extends CollabPeerIdentity {
  /** 会话内唯一，取自 Yjs 的 clientID。断线重连后会变。 */
  id: number;
  local: boolean;
}

/**
 * 协同接入被拒绝的原因。
 *
 * 目前只有一种，而它是硬拒绝而不是降级：y-prosemirror 解码共享文档时，遇到本端
 * Schema 里没有的节点会**把那个节点从共享文档里删掉**——缺插件的客户端不是"打不开"，
 * 是替所有人删内容。§9.3 承诺的"缺插件不丢内容"在协同下只能靠不接入来兑现。
 */
export interface CollabRejection {
  code: "schema-incompatible";
  /** 共享文档里本端 Schema 不认识的节点名，按出现顺序去重。 */
  unknownNodes: string[];
  /** 同上，标记名。标记不会触发删除，但同样意味着本端表达不全。 */
  unknownMarks: string[];
  message: string;
}

/** 协同会话的对外状态。未配置协同时 `enabled` 为 false，其余字段为静止值。 */
export interface CollabState {
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

/**
 * 事件名。只列出当前真实会派发的事件；后续切片按需增补
 * （`patch` 等见方案 §9.4）。
 */
export type EditorEventName =
  | "change"
  | "compositionChanged"
  | "documentDegraded"
  | "limitExceeded"
  | "patch"
  | "pluginError"
  | "clipboardNotice"
  | "collabChanged"
  | "collabRejected";

/** 事件载荷。没有载荷的事件为 `undefined`，`() => void` 形态的监听器照常可用。 */
export interface EditorEventPayload {
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

/**
 * 编辑器三态。语义互不相同，不能用一个布尔量表达（方案 §4.1）：
 *
 * - `edit`：可编辑。
 * - `readonly`：不可编辑，但**可聚焦、可选中、可复制**——阅读态要能取词。
 * - `disabled`：不可编辑且**不可聚焦**，不进 Tab 序，对辅助技术报 `aria-disabled`。
 */
export type EditorMode = "edit" | "readonly" | "disabled";

/**
 * 引用稳定的状态快照：状态未变时必须返回同一个对象。
 * React 18 的 `useSyncExternalStore` 要求 getSnapshot 可缓存，
 * 每次返回新对象会直接抛 `The result of getSnapshot should be cached`。
 */
export interface EditorSnapshot {
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

/**
 * 节点/标记的 DOM 表达。刻意不包含 `Node`、`{dom}` 等运行时 DOM 形态：
 * `toDOM` 只能返回纯数据结构，禁止访问 `document`，服务端才能复用同一份
 * Schema 渲染 HTML（方案 §7.1、§12.1）。
 */
export type DomOutputSpec = string | readonly [string, ...DomOutputSpecChild[]];
export type DomOutputSpecChild = DomOutputSpec | Record<string, string> | 0;

export interface CoreTagParseRule {
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

export interface CoreStyleParseRule {
  style: string;
  priority?: number;
}

/** DOM 属性的声明式读取与规范化规则。 */
export interface CoreDOMAttributeRule {
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

/** 节点只能按标签解析；样式解析只对标记有意义。 */
export type CoreParseRule = CoreTagParseRule | CoreStyleParseRule;

/**
 * Markdown 序列化上下文。只做字符串运算，不触碰 DOM——与 `toDOM` 同一条约束，
 * 因此同一份映射在浏览器和 Node 里结果相同（方案 §12.1）。
 */
export interface MarkdownSerializeContext {
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

/**
 * `toMarkdown` 能看到的节点视图。和 `CoreNodeView` 的区别是多一个 `content`：
 * 表格必须先知道有几列才能写出对齐行，光有 `attrs` 排不出来。
 */
export interface CoreMarkdownNodeView {
  attrs: Record<string, unknown>;
  content: readonly NodeJSON[];
}

/** 节点 → Markdown 片段。行内节点返回行内片段，块节点返回不含首尾空行的块。 */
export type CoreNodeToMarkdown = (
  node: CoreMarkdownNodeView,
  context: MarkdownSerializeContext,
) => string;

/** 标记 → Markdown 片段。`content` 是已经渲染好的行内内容。 */
export type CoreMarkToMarkdown = (mark: CoreMarkView, content: string) => string;

/**
 * Markdown 解析规则。与 `parseDOM` 同一套立场：只有声明，没有可执行钩子——
 * 规则要能被审计，也要能在服务端复用。
 */
export interface CoreMarkdownParseRule {
  /** markdown-it 的 token 类型。成对 token 写去掉 `_open` 的名字，如 `heading`。 */
  token: string;
  /** 进一步按 token 的标签名区分，用于 `h1`–`h6` 这种同类型多标签的情况。 */
  tag?: string;
  /** 命中时写入的固定属性。 */
  attrs?: Record<string, unknown>;
  /** 从 token 上声明式读取的属性。 */
  attrsFromToken?: Record<string, CoreMarkdownAttributeRule>;
}

/** Markdown token 属性的声明式读取与规范化规则。 */
export interface CoreMarkdownAttributeRule {
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

export interface CoreAttrSpec {
  default?: unknown;
}

/**
 * `toDOM` 能看到的节点视图。刻意只有 `attrs`：渲染函数拿不到 ProseMirror 节点，
 * 也就无法访问文档内部或 DOM，服务端才能复用同一份渲染逻辑（方案 §7.1、§12.1）。
 */
export interface CoreNodeView {
  attrs: Record<string, unknown>;
}

/** 标记渲染函数只可读取自身的持久化属性。 */
export interface CoreMarkView {
  attrs: Record<string, unknown>;
}

export interface CoreNodeSpec {
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

export interface CoreMarkSpec {
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
