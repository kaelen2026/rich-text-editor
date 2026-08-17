/**
 * AI 服务契约（方案 §17）。
 *
 * 与 S11 的 `AssetUploader` 同一条立场：**模型是宿主的，不是编辑器的。** 这个包
 * 不认识任何厂商、不持有任何密钥、也不发一个字节的网络请求——它只定义"要什么、
 * 什么时候取消、结果长什么样"，把调用留给宿主。换 Claude、换自建模型、换一段
 * 本地规则，编辑器这一侧不需要知道。
 */

/**
 * 请求意图。三种的**目标区间语义不同**，这决定了结果落在哪：
 *
 * - `rewrite`：结果替换掉选区本身。
 * - `continue`：结果插在光标处，选区为空。
 * - `summarize`：原文是选区，结果作为独立段落插在选区所在块之后。
 */
export type AiAction = "rewrite" | "continue" | "summarize";

export interface AiRequest {
  action: AiAction;
  /** 交给模型的原文。`continue` 传的是光标之前的上文。 */
  text: string;
  /** 用户附加的要求，例如"更正式一些"。 */
  instruction?: string;
}

export interface AiRunOptions {
  /** 本次请求的运行时标识。只存在于内存，绝不进入文档。 */
  requestId: string;
  /**
   * 取消信号。用户撤销掉目标位置、卸载编辑器或点"取消"时都会触发，宿主应当
   * 据此中止真实的模型调用——否则代价照付，而结果一定会被丢弃。
   */
  signal: AbortSignal;
  /**
   * 流式增量。给了就边生成边预览，不给就等最终结果。
   *
   * **增量只进预览，不进文档。** 每个 token 派发一次文档事务会污染撤销栈、
   * 灌爆 `patch` 流，也违反 §9.5 第 1 条"状态存在 plugin state"。真正写进
   * 文档的只有最终结果那一笔。
   */
  onDelta?(delta: string): void;
}

/**
 * 失败原因。刻意区分这两种，因为它们对用户是两件事：
 *
 * - `refused`：模型能答但选择不答。重试同一段原文大概率还是这个结果。
 * - `unavailable`：没连上、超时、额度用尽。重试有意义。
 */
export type AiFailureReason = "refused" | "unavailable";

export type AiResult =
  | { ok: true; text: string }
  | { ok: false; reason: AiFailureReason; message: string };

/**
 * 宿主注入的模型服务。
 *
 * 拒答是**返回值不是异常**：真实模型把拒答作为一次成功的响应给出（带一个停止
 * 原因），把它抛成异常会让"模型不想答"和"服务挂了"在调用方那里长得一模一样。
 */
export interface AiService {
  run(request: AiRequest, options: AiRunOptions): Promise<AiResult>;
}
