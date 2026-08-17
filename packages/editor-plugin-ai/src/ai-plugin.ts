import type { SessionBridge, SessionExtension } from "@kaelen/editor-pm-adapter";
import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import { Fragment, type Node as ProseMirrorNode, type Schema, Slice } from "prosemirror-model";
import { type EditorState, Plugin, PluginKey, type Transaction } from "prosemirror-state";
import type { Mapping } from "prosemirror-transform";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { AiAction, AiRequest, AiResult, AiService } from "./ai-service";

/** 续写交给模型的上文长度上限。够它接住语气，又不至于把整篇文档塞过去。 */
const CONTEXT_CHARACTERS = 2000;

/**
 * 流式增量的合流窗口。
 *
 * 每个 token 派发一次事务会让宿主每秒重渲染几十次；攒一小段再派发，预览看上去
 * 一样连续，而事务数量降一个量级。
 */
const DELTA_FLUSH_MS = 60;

export interface AiPluginOptions {
  service: AiService;
}

export type AiRequestStatus = "generating" | "failed";

/** 结果落成行内文本还是独立段落。摘要是后者，改写与续写是前者。 */
export type AiInsertMode = "inline" | "block";

/**
 * 一次进行中的 AI 请求。**它不在文档里。**
 *
 * `from`/`to` 是结果最终要替换掉的区间（续写与摘要是空区间，即插入点），
 * 每一笔事务都会用 `tr.mapping` 迁移它——这正是 §9.5 第 2 条。
 */
export interface AiRequestRecord {
  requestId: string;
  action: AiAction;
  from: number;
  to: number;
  insertAs: AiInsertMode;
  status: AiRequestStatus;
  /** 流式增量的累积，只用于预览。 */
  preview: string;
  error?: string;
}

export interface AiRequestState {
  requests: readonly AiRequestRecord[];
}

type AiMeta =
  | { kind: "start"; record: AiRequestRecord }
  | { kind: "delta"; requestId: string; preview: string }
  | { kind: "failed"; requestId: string; error: string }
  | { kind: "remove"; requestId: string };

export const aiRequestKey = new PluginKey<AiRequestState>("ai-request");

/**
 * 可选 AI 能力：改写、续写、摘要。
 *
 * **这一片的难点不是模型调用，是位置。** 请求发出到结果返回之间用户还在编辑，
 * 发出时算好的位置一定是过期的。因此全程遵守 §9.5 的异步契约，与图片上传
 * （S11）用的是同一套机制而不是另造一套：状态存 plugin state、每个事务重新
 * 映射、UI 用 Decoration、目标消失就丢弃结果。
 *
 * 本插件**不贡献任何节点或标记**——AI 不产生新的文档结构，它只产生文字。
 * 因此它也没有 `structureVersion`：卸载它，文档一字不变。
 */
export function createAiPlugin(options: AiPluginOptions): EditorPlugin {
  const controller = new AiController(options.service);
  return {
    name: "ai",
    version: "1.0.0",
    namespace: "co_",
    registerCommands: (commands) => {
      commands.add("ai.rewrite", controller.command("rewrite"));
      commands.add("ai.continue", controller.command("continue"));
      commands.add("ai.summarize", controller.command("summarize"));
      commands.add("ai.retry", controller.retryCommand);
      commands.add("ai.cancel", controller.cancelCommand);
    },
    createSessionExtensions: () => [controller],
  };
}

class AiController implements SessionExtension {
  private bridge: SessionBridge | undefined;
  private readonly active = new Map<string, AbortController>();
  /** 重试要用原来那份请求，因此留着。与 `active` 不同，它到收尾才清。 */
  private readonly pending = new Map<string, AiRequest>();
  /** 未冲刷的流式增量，见 `DELTA_FLUSH_MS`。 */
  private readonly buffered = new Map<string, string>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;

  constructor(private readonly service: AiService) {}

  /** 三条发起命令只差"目标区间怎么算"，其余完全一样。 */
  command(action: AiAction): SessionCommand {
    return {
      run: (_session, apply, input) => {
        const plan = this.plan(action, input);
        if (typeof plan === "string") {
          return { ok: false, reason: "disabled", detail: plan };
        }
        if (!apply) {
          return { ok: true };
        }
        this.start(plan);
        return { ok: true };
      },
      enabled: () => typeof this.plan(action) !== "string",
      active: () => false,
    };
  }

  readonly retryCommand: SessionCommand = {
    run: (_session, apply, input) => {
      const record = this.recordForInput(input, "failed");
      const request = record ? this.pending.get(record.requestId) : undefined;
      if (!record || !request || !this.bridge) {
        return { ok: false, reason: "disabled", detail: "没有可重试的 AI 请求" };
      }
      if (!apply) {
        return { ok: true };
      }
      this.dispatchMeta({ kind: "delta", requestId: record.requestId, preview: "" });
      this.begin(record.requestId, request);
      return { ok: true };
    },
    enabled: (_session, input) => this.recordForInput(input, "failed") !== undefined,
    active: () => false,
  };

  /** 取消进行中的，或收掉一条失败记录。两者对用户是同一个动作：别管它了。 */
  readonly cancelCommand: SessionCommand = {
    run: (_session, apply, input) => {
      const record = this.recordForInput(input);
      if (!record || !this.bridge) {
        return { ok: false, reason: "disabled", detail: "没有进行中的 AI 请求" };
      }
      if (!apply) {
        return { ok: true };
      }
      this.abort(record.requestId);
      this.pending.delete(record.requestId);
      this.dispatchMeta({ kind: "remove", requestId: record.requestId });
      return { ok: true };
    },
    enabled: (_session, input) => this.recordForInput(input) !== undefined,
    active: () => false,
  };

  plugins(): readonly Plugin[] {
    return [
      new Plugin<AiRequestState>({
        key: aiRequestKey,
        state: {
          init: () => ({ requests: [] }),
          apply: (transaction, value) => this.applyMeta(transaction, value),
        },
        props: {
          decorations: (state) => this.decorations(state),
        },
        // 目标位置在编辑中消失时，飞行中的请求没有任何落点了。留着它只是
        // 继续付账，因此当场中止——而不是等结果回来再丢。
        view: () => ({
          update: (view: EditorView) => this.abortOrphans(view.state),
        }),
      }),
    ];
  }

  bind(bridge: SessionBridge): void {
    this.bridge = bridge;
  }

  /** React StrictMode 的 unmount 与真正 destroy 都必须中止仍在飞行的请求。 */
  unmount(): void {
    for (const requestId of this.abortAll()) {
      this.dispatchMeta({ kind: "remove", requestId });
    }
  }

  destroy(): void {
    this.abortAll();
    this.clearFlushTimer();
    this.pending.clear();
    this.buffered.clear();
    this.bridge = undefined;
  }

  /**
   * 算出这次请求要读哪段原文、结果要落在哪。
   *
   * 返回字符串表示做不了，字符串本身就是给用户看的原因。
   */
  private plan(action: AiAction, input?: unknown): AiPlan | string {
    const state = this.bridge?.getState();
    if (!state) {
      return "编辑器尚未就绪";
    }
    const { selection, doc } = state;
    const instruction = instructionFrom(input);
    if (action === "continue") {
      const at = selection.to;
      if (this.covering(state, at, at)) {
        return "这里已经有一个进行中的 AI 请求";
      }
      // 上文取到光标为止的尾段：模型要接住语气，但没必要看完整篇文档。
      const context = doc.textBetween(0, at, "\n").slice(-CONTEXT_CHARACTERS);
      if (context.trim().length === 0) {
        return "光标前没有可续写的内容";
      }
      return {
        request: { action, text: context, ...(instruction ? { instruction } : {}) },
        from: at,
        to: at,
        insertAs: "inline",
      };
    }

    if (selection.empty) {
      return action === "rewrite" ? "请先选中要改写的文字" : "请先选中要摘要的文字";
    }
    const text = doc.textBetween(selection.from, selection.to, "\n");
    if (text.trim().length === 0) {
      return "选中的内容没有文字";
    }
    if (this.covering(state, selection.from, selection.to)) {
      return "这段文字上已经有一个进行中的 AI 请求";
    }
    if (action === "rewrite") {
      return {
        request: { action, text, ...(instruction ? { instruction } : {}) },
        from: selection.from,
        to: selection.to,
        insertAs: "inline",
      };
    }
    // 摘要不动原文：落点是选区所在块的后面，结果自成一段。
    const $to = selection.$to;
    if ($to.depth === 0) {
      return "无法确定摘要的插入位置";
    }
    const at = $to.after($to.depth);
    return {
      request: { action, text, ...(instruction ? { instruction } : {}) },
      from: at,
      to: at,
      insertAs: "block",
    };
  }

  private start(plan: AiPlan): void {
    const bridge = this.bridge;
    if (!bridge) {
      return;
    }
    this.sequence += 1;
    const requestId = `ai-${this.sequence}`;
    const record: AiRequestRecord = {
      requestId,
      action: plan.request.action,
      from: plan.from,
      to: plan.to,
      insertAs: plan.insertAs,
      status: "generating",
      preview: "",
    };
    this.pending.set(requestId, plan.request);
    // 发起本身不改文档，因此这一笔事务不进历史也不产生 patch。
    this.dispatchMeta({ kind: "start", record });
    this.begin(requestId, plan.request);
  }

  private begin(requestId: string, request: AiRequest): void {
    const abort = new AbortController();
    this.active.set(requestId, abort);
    void this.service
      .run(request, {
        requestId,
        signal: abort.signal,
        onDelta: (delta) => this.pushDelta(requestId, delta),
      })
      .then((result) => this.settle(requestId, result, abort))
      .catch((error: unknown) => {
        if (!abort.signal.aborted) {
          this.settle(
            requestId,
            { ok: false, reason: "unavailable", message: describeError(error) },
            abort,
          );
        }
      });
  }

  private settle(requestId: string, result: AiResult, abort: AbortController): void {
    if (abort.signal.aborted) {
      return;
    }
    this.active.delete(requestId);
    this.buffered.delete(requestId);
    if (!result.ok) {
      this.fail(requestId, result.message);
      return;
    }
    this.complete(requestId, result.text);
  }

  /**
   * 把结果写进文档。这是整个流程里**唯一**一笔文档事务。
   *
   * 位置取自 plugin state 里已经被映射过的 `from`/`to`，不是发起时算的那对数字
   * （§9.5 第 5 条）。记录已经不在了，说明目标位置在生成期间被删掉了——结果
   * 直接丢弃，不去猜它该落在哪。
   *
   * **这一笔进历史**，与图片上传的回填相反。那里进历史的是"插入占位图"那一笔，
   * 回填只是把占位换成真图，再记一次会让撤销停在 loading 态；而 AI 生成期间
   * 文档一字未动，这一笔就是用户看到的那次编辑本身，不记就再也撤不回去了。
   */
  private complete(requestId: string, text: string): void {
    const bridge = this.bridge;
    const record = this.record(requestId);
    this.pending.delete(requestId);
    if (!bridge || !record) {
      return;
    }
    const state = bridge.getState();
    const content = resultSlice(state.schema, text, record.insertAs);
    if (!content) {
      this.fail(requestId, "模型没有返回可用的内容");
      return;
    }
    const transaction = state.tr
      .replace(record.from, record.to, content)
      .setMeta(aiRequestKey, { kind: "remove", requestId } satisfies AiMeta);
    bridge.dispatch(transaction);
  }

  private fail(requestId: string, error: string): void {
    if (!this.record(requestId)) {
      // 目标已经没了，失败也没什么好提示的。
      this.pending.delete(requestId);
      return;
    }
    this.dispatchMeta({ kind: "failed", requestId, error });
  }

  /** 增量先攒着，到点一次性推给 plugin state。 */
  private pushDelta(requestId: string, delta: string): void {
    if (!delta || !this.active.has(requestId)) {
      return;
    }
    this.buffered.set(requestId, (this.buffered.get(requestId) ?? "") + delta);
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.flushDeltas();
    }, DELTA_FLUSH_MS);
  }

  private flushDeltas(): void {
    for (const [requestId, preview] of this.buffered) {
      if (this.record(requestId)) {
        this.dispatchMeta({ kind: "delta", requestId, preview });
      }
    }
    this.buffered.clear();
  }

  private applyMeta(transaction: Transaction, value: AiRequestState): AiRequestState {
    const requests: AiRequestRecord[] = [];
    for (const record of value.requests) {
      const range = mapRange(transaction.mapping, record);
      // 位置被删除（§9.5 第 3 条）。这个功能的语义是丢弃：把改写结果塞回一段
      // 已经不存在的文字旁边，比什么都不做更糟。
      if (range) {
        requests.push({ ...record, ...range });
      }
    }
    const meta = transaction.getMeta(aiRequestKey) as AiMeta | undefined;
    if (!meta) {
      return { requests };
    }
    if (meta.kind === "start") {
      return { requests: [...requests, meta.record] };
    }
    if (meta.kind === "remove") {
      return { requests: requests.filter((record) => record.requestId !== meta.requestId) };
    }
    return {
      requests: requests.map((record) => {
        if (record.requestId !== meta.requestId) {
          return record;
        }
        return meta.kind === "delta"
          ? { ...record, preview: record.preview + meta.preview }
          : { ...record, status: "failed", error: meta.error };
      }),
    };
  }

  private abortOrphans(state: EditorState): void {
    if (this.active.size === 0) {
      return;
    }
    const live = new Set(
      (aiRequestKey.getState(state)?.requests ?? []).map((record) => record.requestId),
    );
    for (const requestId of [...this.active.keys()]) {
      if (!live.has(requestId)) {
        this.abort(requestId);
        this.pending.delete(requestId);
      }
    }
  }

  private decorations(state: EditorState): DecorationSet {
    const requests = aiRequestKey.getState(state)?.requests ?? [];
    if (requests.length === 0) {
      return DecorationSet.empty;
    }
    const decorations = requests.flatMap((record) => {
      const label = record.status === "failed" ? (record.error ?? "生成失败") : record.preview;
      const widget = Decoration.widget(record.from, () => indicator(record, label), {
        side: -1,
        // 预览每变一次就换一次 key，否则 ProseMirror 会沿用旧的 DOM。
        key: `ai-${record.requestId}-${record.status}-${label.length}`,
      });
      if (record.to <= record.from) {
        return [widget];
      }
      return [
        Decoration.inline(record.from, record.to, {
          class: `co-ai-${record.status}`,
          "data-ai-status": record.status,
        }),
        widget,
      ];
    });
    return DecorationSet.create(state.doc, decorations);
  }

  /** 这段区间上是否已经有请求在跑。重叠的两次改写会互相覆盖。 */
  private covering(state: EditorState, from: number, to: number): boolean {
    return (aiRequestKey.getState(state)?.requests ?? []).some(
      (record) => record.status === "generating" && record.from <= to && record.to >= from,
    );
  }

  private record(requestId: string): AiRequestRecord | undefined {
    const state = this.bridge?.getState();
    return state
      ? aiRequestKey.getState(state)?.requests.find((record) => record.requestId === requestId)
      : undefined;
  }

  /**
   * 命令的作用对象。宿主可以显式传 `requestId`，否则取与当前选区相交的那一条
   * ——运行时标识不必为了点一次"取消"就暴露给 UI。
   */
  private recordForInput(input: unknown, status?: AiRequestStatus): AiRequestRecord | undefined {
    const state = this.bridge?.getState();
    if (!state) {
      return undefined;
    }
    const records = aiRequestKey.getState(state)?.requests ?? [];
    const matches = (record: AiRequestRecord) => !status || record.status === status;
    const explicit = requestIdFrom(input);
    if (explicit) {
      return records.find((record) => record.requestId === explicit && matches(record));
    }
    const { from, to } = state.selection;
    return records.find((record) => matches(record) && record.from <= to && record.to >= from);
  }

  private dispatchMeta(meta: AiMeta): void {
    const bridge = this.bridge;
    if (!bridge) {
      return;
    }
    bridge.dispatch(bridge.getState().tr.setMeta(aiRequestKey, meta));
  }

  private abort(requestId: string): void {
    this.active.get(requestId)?.abort();
    this.active.delete(requestId);
    this.buffered.delete(requestId);
  }

  private abortAll(): string[] {
    const requestIds = [...this.active.keys()];
    for (const requestId of requestIds) {
      this.abort(requestId);
    }
    return requestIds;
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}

interface AiPlan {
  request: AiRequest;
  from: number;
  to: number;
  insertAs: AiInsertMode;
}

/**
 * 把持有的区间迁移到新文档上；目标已经不存在时返回 null。
 *
 * 两端的偏向刻意相反：`from` 偏后、`to` 偏前，于是紧贴着区间外侧输入的文字
 * 留在区间之外——改写不该把用户新打的字一起吃掉。空区间（续写、摘要的插入点）
 * 统一偏后：在光标处继续打字，续写的结果应该落在打完的字后面。
 */
function mapRange(mapping: Mapping, record: AiRequestRecord): { from: number; to: number } | null {
  if (record.to <= record.from) {
    const at = mapping.mapResult(record.from, 1);
    return at.deletedAcross ? null : { from: at.pos, to: at.pos };
  }
  const start = mapping.mapResult(record.from, 1);
  const end = mapping.mapResult(record.to, -1);
  // 区间被整段删掉时两端会撞在一起，这是"目标消失"最常见的形态。
  return end.pos <= start.pos ? null : { from: start.pos, to: end.pos };
}

/**
 * 模型返回的纯文本 → 可插入的 Slice。
 *
 * 空行分段。行内插入的两端开着口（`openStart`/`openEnd` 为 1），因此单段结果
 * 就是普通的文字替换，多段结果会正确地在原文所在的块里断开——这也是为什么
 * 不用 `insertText`：那样多段结果会被拍平成一行。
 */
function resultSlice(schema: Schema, text: string, insertAs: AiInsertMode): Slice | null {
  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) {
    return null;
  }
  const blocks = text
    .split(/\n{2,}/)
    .map((block) => block.replace(/\s*\n\s*/g, " ").trim())
    .filter((block) => block.length > 0);
  if (blocks.length === 0) {
    return null;
  }
  const paragraphs: ProseMirrorNode[] = blocks.map((block) =>
    paragraphType.create(null, schema.text(block)),
  );
  const open = insertAs === "inline" ? 1 : 0;
  return new Slice(Fragment.from(paragraphs), open, open);
}

function indicator(record: AiRequestRecord, label: string): HTMLElement {
  const element = document.createElement("span");
  element.className = `co-ai-indicator co-ai-indicator-${record.status}`;
  element.dataset.aiRequest = record.requestId;
  element.dataset.aiStatus = record.status;
  element.dataset.aiAction = record.action;
  element.textContent = label || (record.status === "failed" ? "生成失败" : "生成中…");
  return element;
}

function instructionFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("instruction" in input)) {
    return undefined;
  }
  const instruction = (input as { instruction: unknown }).instruction;
  return typeof instruction === "string" && instruction.trim().length > 0
    ? instruction.trim()
    : undefined;
}

function requestIdFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || !("requestId" in input)) {
    return undefined;
  }
  const requestId = (input as { requestId: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
