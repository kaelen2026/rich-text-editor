import { type CollabProvider, createWebSocketCollabProvider } from "@kaelen/editor-collab";
import type { CollabSessionOptions } from "@kaelen/editor-pm-adapter";

/**
 * playground 的协同接线。
 *
 * 用查询参数开而不是常开：协同要有服务端才有意义，而 playground 的默认形态是
 * 单机的。`?collab=<房间名>` 打开，`pnpm demo:collab-server` 起服务。
 *
 * 这里做的事全是**宿主的事**：选传输、给身份、决定房间怎么来。编辑器只收一个
 * `CollabProvider`，换成 WebRTC 或自家网关都不需要动它。
 */
const params = typeof window === "undefined" ? undefined : new URLSearchParams(location.search);

export const COLLAB_ROOM = params?.get("collab") ?? null;

/** 光标颜色按 clientID 定，同一个人刷新前后不变，也不需要随机数。 */
const PEER_COLORS = ["#2f6fed", "#c2410c", "#0f766e", "#7c3aed", "#b91c1c", "#0369a1"];

/**
 * 一个页面一条连接，与编辑器实例的生死无关。
 *
 * 两个理由。其一，StrictMode 会把 `useState` 的初始化函数跑两遍，跟着实例走就会
 * 开两条连接、在别人眼里变成两个人。其二更本质：**传输不是编辑器的一部分**——
 * 切换插件配置会换一个编辑器实例，那时不该顺手把连接也断掉。
 */
let shared: CollabSessionOptions | undefined;

export function createCollabOptions(): CollabSessionOptions | undefined {
  if (!COLLAB_ROOM) {
    return undefined;
  }
  if (!shared) {
    const provider = createWebSocketCollabProvider({
      url: params?.get("collabUrl") ?? "ws://127.0.0.1:4320",
      room: COLLAB_ROOM,
    });
    const color = PEER_COLORS[provider.doc.clientID % PEER_COLORS.length] ?? "#2f6fed";
    shared = {
      provider,
      peer: { name: params?.get("name") ?? `访客 ${provider.doc.clientID % 1000}`, color },
    };
  }
  return shared;
}

/** 页面离开时收摊。编辑器实例换了不算离开，因此这里不由 `destroy()` 调用。 */
export function destroyCollab(): void {
  (shared?.provider as CollabProvider | undefined)?.destroy();
  shared = undefined;
}
