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
 * 事件名。只列出当前真实会派发的事件；后续切片按需增补
 * （`patch` 等见方案 §9.4）。
 */
export type EditorEventName =
  | "change"
  | "compositionChanged"
  | "documentDegraded"
  | "patch"
  | "pluginError";

/** 事件载荷。没有载荷的事件为 `undefined`，`() => void` 形态的监听器照常可用。 */
export interface EditorEventPayload {
  change: undefined;
  compositionChanged: boolean;
  documentDegraded: undefined;
  pluginError: PluginError;
  /** 每个内容事务一条，可用于增量保存、协同和版本历史。 */
  patch: DocumentPatch;
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
  type?: "integer";
  min?: number;
  max?: number;
  default?: unknown;
}

/** 节点只能按标签解析；样式解析只对标记有意义。 */
export type CoreParseRule = CoreTagParseRule | CoreStyleParseRule;

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
}

export interface CoreMarkSpec {
  attrs?: Record<string, CoreAttrSpec>;
  parseDOM?: CoreParseRule[];
  toDOM?: (mark: CoreMarkView) => DomOutputSpec;
}
