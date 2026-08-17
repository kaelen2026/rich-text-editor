import type { RichEditor } from "@kaelen/editor-api";
import type { AiResult } from "@kaelen/editor-plugin-ai";
import type { SessionBridge, SessionExtension } from "@kaelen/editor-pm-adapter";
import type { EditorPlugin } from "@kaelen/editor-runtime";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

/**
 * 真实浏览器用例的接线口，只在 `?e2e=1` 时装上。
 *
 * 组合态契约（方案 §9.6）里有三条只有真实输入法事件才验得了：输入规则不在组合态
 * 执行、程序化事务被挂起到 `compositionend` 且位置重新映射、覆盖当前文本节点的
 * Decoration 被冻结。jsdom 造不出真实的 composition 时序，所以这几条走 Playwright
 * 加 CDP。
 *
 * 用查询参数开而不是常开：这些钩子是给自动化用的，不该出现在有人随手打开
 * playground 的那份页面上。
 */
export const E2E_ENABLED =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("e2e");

/** 页面上暴露给用例的对象。名字带前缀，避免和任何库的全局变量撞上。 */
export interface E2EHooks {
  editor: RichEditor;
  /**
   * 在文档末尾插入一段文字，走的是能力插件异步回填用的那条 `SessionBridge`
   * 通道——不是 `execute()`。§9.6 第 2 条要挂起并重映射的正是这一类事务，而
   * `execute()` 走的是第 5 条（直接拒绝）。
   */
  dispatchProgrammaticInsert(text: string): void;
  /**
   * 兑现最早那个待决的 AI 请求。
   *
   * `?e2e=1` 下 playground 的模拟服务不再自己走定时器：用例要断言的是"结果在
   * 组合态的哪一刻到达"，而那一刻必须由用例说了算。
   */
  settleAi(result: AiResult): boolean;
}

declare global {
  interface Window {
    __editorE2E?: E2EHooks;
  }
}

const probeKey = new PluginKey("e2e-decoration-probe");

/** 一个编辑器实例对应一套探针。状态全挂在这个对象上，不落到模块作用域。 */
export interface E2EProbe {
  plugins: EditorPlugin[];
  bridge(): SessionBridge | undefined;
}

/**
 * 探针插件：给光标所在的文本块铺一层 Decoration，属性里带上它被重算的次数，
 * 同时把 `SessionBridge` 接出来供用例派发程序化事务。
 *
 * 冻结那条契约需要一个"覆盖当前文本节点"的 Decoration 才验得了，而仓库里现有的
 * 唯一 Decoration（图片上传占位）覆盖的是图片节点。判据取渲染到 DOM 上的属性值
 * 而不是函数调用次数：契约要拦的是"那段 DOM 被重建"，函数被调用本身无害。
 *
 * 每次调用造一套新的、状态不落在模块作用域：StrictMode 会把编辑器建两遍，共享
 * 变量会让钩子指向那个被丢弃、从没挂载过的实例。
 */
export function createE2EProbe(): E2EProbe {
  if (!E2E_ENABLED) {
    return { plugins: [], bridge: () => undefined };
  }
  let renders = 0;
  let bridge: SessionBridge | undefined;

  const plugin: EditorPlugin = {
    name: "e2eprobe",
    version: "0.0.1",
    namespace: "co_",
    createSessionExtensions: (): readonly SessionExtension[] => [
      {
        plugins: () => [
          new Plugin({
            key: probeKey,
            props: {
              decorations(state) {
                const { $from, empty } = state.selection;
                if (!empty || !$from.parent.isTextblock || $from.parent.content.size === 0) {
                  return DecorationSet.empty;
                }
                renders += 1;
                const start = $from.start();
                return DecorationSet.create(state.doc, [
                  Decoration.inline(start, start + $from.parent.content.size, {
                    class: "e2e-probe",
                    "data-probe-render": String(renders),
                  }),
                ]);
              },
            },
          }),
        ],
        bind: (session) => {
          bridge = session;
        },
        destroy: () => {
          bridge = undefined;
        },
      },
    ],
  };

  return { plugins: [plugin], bridge: () => bridge };
}

export function exposeE2EHooks(
  editor: RichEditor,
  probe: E2EProbe,
  settleAi: (result: AiResult) => boolean,
): void {
  if (!E2E_ENABLED) {
    return;
  }
  window.__editorE2E = {
    editor,
    settleAi,
    dispatchProgrammaticInsert(text) {
      const bridge = probe.bridge();
      if (!bridge) {
        return;
      }
      const state = bridge.getState();
      // 位置在派发时算定。组合期间如果先插了字，这个位置就过期了——冲刷时必须
      // 按映射后的位置落，否则回填会插到别人中间。
      bridge.dispatch(state.tr.insertText(text, state.doc.content.size - 1));
    },
  };
}
