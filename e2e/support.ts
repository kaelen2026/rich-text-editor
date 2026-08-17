import type { CDPSession, Page } from "@playwright/test";
import { expect } from "@playwright/test";

// 钩子的形状与 `window.__editorE2E` 的全局声明都由 playground 那一侧给出。
// 只借类型，编译期就抹掉，用例不会真把 playground 的模块拉进 Node 进程；
// 照抄一份镜像声明才是隐患——两边漂了也没人报错。
import type { E2EHooks } from "../apps/playground/src/e2e-hooks";

export type PlaygroundHooks = E2EHooks;

export const EDITOR = ".ProseMirror";

/** 打开 playground 并等到编辑器真的可编辑，再把上一次的 localStorage 清掉。 */
export async function openPlayground(page: Page): Promise<void> {
  await page.addInitScript(() => window.localStorage.clear());
  await page.goto("/?e2e=1");
  await expect(page.locator(EDITOR)).toBeVisible();
  await page.waitForFunction(() => window.__editorE2E !== undefined);
  await page.locator(EDITOR).click();
  // 从一份干净的空段落开始，避免上一条用例或 localStorage 残留影响断言。
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
}

/**
 * 用 CDP 驱动一次真实的输入法组合。
 *
 * `Input.imeSetComposition` 是唯一能让 Chromium 产生 `compositionstart` /
 * `compositionupdate` 并把候选文本铺进 DOM 的接口；`Input.insertText` 收尾会触发
 * `compositionend`。手工派发 CompositionEvent 造不出这套时序——那正是 jsdom 验不了
 * 组合态的原因。
 */
export async function composeText(cdp: CDPSession, steps: string[]): Promise<void> {
  for (const step of steps) {
    await cdp.send("Input.imeSetComposition", {
      text: step,
      selectionStart: step.length,
      selectionEnd: step.length,
    });
  }
}

/** 结束组合并上屏最终文本。 */
export async function commitComposition(cdp: CDPSession, text: string): Promise<void> {
  await cdp.send("Input.insertText", { text });
}

/**
 * 派发一次真实的 paste 事件。
 *
 * 走 `ClipboardEvent` + `DataTransfer` 而不是 `page.keyboard.press("Meta+V")`：
 * 后者要先把内容写进系统剪贴板，在无头环境里不可靠，而且写不进多种 MIME。
 * 这里造出来的事件与浏览器自己派发的走同一条 ProseMirror 处理路径。
 */
export async function pasteHTML(page: Page, html: string, plain = ""): Promise<void> {
  await page.locator(EDITOR).evaluate(
    (element, payload) => {
      const data = new DataTransfer();
      data.setData("text/html", payload.html);
      data.setData("text/plain", payload.plain);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { html, plain },
  );
}

export function editorText(page: Page): Promise<string> {
  return page.locator(EDITOR).innerText();
}

export function isComposing(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__editorE2E?.editor.getSnapshot().composing === true);
}
