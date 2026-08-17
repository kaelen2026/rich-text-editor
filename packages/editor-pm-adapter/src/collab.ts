import {
  type CollabProvider,
  collectSharedNames,
  type SharedDocumentNames,
} from "@kaelen/editor-collab";
import type {
  CollabPeer,
  CollabPeerIdentity,
  CollabRejection,
  CollabState,
  CollabStatus,
} from "@kaelen/editor-shared-types";
import type { Schema } from "prosemirror-model";
import type { Command, Plugin } from "prosemirror-state";
import {
  yCursorPlugin,
  redo as yRedo,
  ySyncPlugin,
  undo as yUndo,
  yUndoPlugin,
} from "y-prosemirror";

/** 撤销/重做的具体实现。协同会把它整体换掉，见 `EditorSession.applyHistoryCommand`。 */
export interface HistoryCommands {
  undo: Command;
  redo: Command;
}

/** 协同下由 `Y.UndoManager` 接管：只回退自己的改动，不动别人的。 */
export const collabHistoryCommands: HistoryCommands = { undo: yUndo, redo: yRedo };

export interface CollabSessionOptions {
  provider: CollabProvider;
  /** 本端在别人光标上显示的名字与颜色。 */
  peer?: CollabPeerIdentity;
}

/** 会话交给协同绑定的回调。绑定不直接持有会话，避免两边互相知道太多。 */
export interface CollabBindingHooks {
  /** 重建 `EditorState` 的插件表——装上或卸下协同插件。 */
  reconfigure(): void;
  /** 状态变了，通知宿主。 */
  changed(): void;
  rejected(rejection: CollabRejection): void;
}

/**
 * 协同会话绑定。
 *
 * 接入面全部收在这里：会话只知道"要不要装协同插件""撤销走哪套实现"，
 * 业务 API 与 Schema 一律不变（方案 §9.4 的兼容性结论）。
 *
 * **绑定是异步的，而且要过一道闸门。** 连上不等于可以编辑共享文档：本端 Schema
 * 必须认得共享文档里的每一个节点名和标记名，否则 y-prosemirror 解码时会把不认识
 * 的部分**从共享文档里删掉**——缺插件的客户端不是"打不开"，是替所有人删内容，
 * 而标记那条删掉的是整段文字。§9.3 承诺的"缺插件不丢内容"在协同下只能靠不接入
 * 来兑现。
 */
export class CollabBinding {
  private schema: Schema | undefined;
  private hooks: CollabBindingHooks | undefined;
  private status: CollabStatus;
  private peers: readonly CollabPeer[];
  private rejection: CollabRejection | undefined;
  private isBound = false;
  private destroyed = false;
  private readonly disposers: Array<() => void> = [];

  constructor(private readonly options: CollabSessionOptions) {
    this.status = options.provider.getStatus();
    this.peers = options.provider.getPeers();
  }

  get provider(): CollabProvider {
    return this.options.provider;
  }

  get bound(): boolean {
    return this.isBound;
  }

  get state(): CollabState {
    return {
      enabled: true,
      status: this.status,
      bound: this.isBound,
      rejection: this.rejection,
      peers: this.peers,
    };
  }

  /** 会话构造完毕后调用：装准入判断、订阅状态，并立刻判一次能不能绑。 */
  attach(schema: Schema, hooks: CollabBindingHooks): void {
    this.schema = schema;
    this.hooks = hooks;
    const provider = this.options.provider;

    if (this.options.peer) {
      provider.setLocalPeer(this.options.peer);
    }
    provider.setInboundFilter((names) => {
      const missing = this.missingNames(names);
      if (!missing) {
        return true;
      }
      // 判断跑在消息投递的调用栈里，退出协作要改插件表和连接状态，
      // 挪到微任务里做，别在别人的栈上重入。
      queueMicrotask(() => this.reject(missing));
      return false;
    });
    this.disposers.push(
      provider.onStatus((status) => {
        this.status = status;
        this.evaluate();
        hooks.changed();
      }),
      provider.onPeers((peers) => {
        this.peers = peers;
        hooks.changed();
      }),
    );
    this.evaluate();
  }

  /** 会话装配插件时调用。未绑定时返回空数组，编辑的就是本地文档。 */
  plugins(): Plugin[] {
    if (!this.isBound) {
      return [];
    }
    const provider = this.options.provider;
    const fragment = provider.doc.getXmlFragment(provider.fragmentName);
    return [ySyncPlugin(fragment), yCursorPlugin(provider.awareness), yUndoPlugin()];
  }

  /**
   * 组合态期间挡住入站更新（方案 §9.6）。
   *
   * y-prosemirror 全文没有一处组合态处理：远端更新一到就整篇重建 DOM，正在被
   * 输入法接管的那段字随即消失。挡在 Yjs 这一层而不是到会话的挂起队列里重放——
   * ySync 的 step 是"整篇替换"，重映射它没有意义。
   */
  setComposing(composing: boolean): void {
    this.options.provider.setInboundPaused(composing);
  }

  destroy(): void {
    this.destroyed = true;
    for (const dispose of this.disposers.splice(0)) {
      dispose();
    }
    this.options.provider.setInboundFilter(null);
    this.options.provider.setInboundPaused(false);
  }

  /**
   * 能不能绑定共享文档。
   *
   * 一旦绑上就不再解绑（除非被拒或销毁）：断线期间照常编辑，重连后由 Yjs 合并，
   * 这正是"一方断网继续编辑、恢复后无丢失"成立的原因。
   */
  private evaluate(): void {
    if (this.destroyed || this.isBound || this.rejection || this.status !== "synced") {
      return;
    }
    const provider = this.options.provider;
    // 准入判断只看每一笔更新；这里再整体扫一遍共享片段，兜住"provider 在本端
    // 装上判断之前就已经同步完"的时序。
    const missing = this.missingNames(
      collectSharedNames(provider.doc.getXmlFragment(provider.fragmentName)),
    );
    if (missing) {
      this.reject(missing);
      return;
    }
    this.isBound = true;
    this.hooks?.reconfigure();
  }

  /** 共享文档里本端 Schema 不认识的名字；全都认识时返回 undefined。 */
  private missingNames(names: SharedDocumentNames): SharedDocumentNames | undefined {
    const schema = this.schema;
    if (!schema) {
      return undefined;
    }
    const nodes = names.nodes.filter((name) => !schema.nodes[name]);
    const marks = names.marks.filter((name) => !schema.marks[name]);
    return nodes.length > 0 || marks.length > 0 ? { nodes, marks } : undefined;
  }

  private reject(missing: SharedDocumentNames): void {
    if (this.destroyed || this.rejection) {
      return;
    }
    this.rejection = {
      code: "schema-incompatible",
      unknownNodes: missing.nodes,
      unknownMarks: missing.marks,
      message: `共享文档用到了本端不支持的 ${describeMissing(missing)}，已退出协作以免损坏其他协作者的内容`,
    };
    const wasBound = this.isBound;
    this.isBound = false;
    const provider = this.options.provider;
    provider.setInboundFilter(null);
    provider.disconnect();
    if (wasBound) {
      this.hooks?.reconfigure();
    }
    this.hooks?.rejected(this.rejection);
    this.hooks?.changed();
  }
}

function describeMissing(missing: SharedDocumentNames): string {
  const parts: string[] = [];
  if (missing.nodes.length > 0) {
    parts.push(`节点 ${missing.nodes.join("、")}`);
  }
  if (missing.marks.length > 0) {
    parts.push(`标记 ${missing.marks.join("、")}`);
  }
  return parts.join("，");
}

/** 未配置协同时的静止状态。宿主不必区分"没开"和"开了但没连上"。 */
export const COLLAB_DISABLED: CollabState = Object.freeze({
  enabled: false,
  status: "disconnected",
  bound: false,
  peers: Object.freeze([]),
});
