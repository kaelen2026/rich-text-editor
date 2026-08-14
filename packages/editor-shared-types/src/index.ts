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

export interface LoadResult {
  ok: boolean;
  /** 是否有内容被降级为只读兜底节点。宿主据此提示用户。 */
  degraded: boolean;
  /** 被兜底的节点名，按文档顺序去重。 */
  unknownNodes: string[];
  errors?: string[];
}

/** 命令失败原因可判别，便于线上定位（方案 §8.1）。 */
export type CommandFailureReason = "disabled" | "destroyed";

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
 * 事件名。只列出当前真实会派发的事件；后续切片按需增补
 * （`patch`、`pluginError`、`documentDegraded` 等见方案 §9.4）。
 */
export type EditorEventName = "change" | "documentDegraded";

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
}

export interface CoreStyleParseRule {
  style: string;
  priority?: number;
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

export interface CoreNodeSpec {
  content?: string;
  group?: string;
  inline?: boolean;
  atom?: boolean;
  marks?: string;
  attrs?: Record<string, CoreAttrSpec>;
  parseDOM?: CoreTagParseRule[];
  toDOM?: (node: CoreNodeView) => DomOutputSpec;
}

export interface CoreMarkSpec {
  parseDOM?: CoreParseRule[];
  toDOM?: () => DomOutputSpec;
}
