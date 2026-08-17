import { type Browser, expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import {
  collabState,
  commitComposition,
  composeText,
  EDITOR,
  editorDocumentText,
  openCollab,
} from "./support";

/**
 * 协同的真实浏览器验收（方案 §17、§19 第 5 条）。
 *
 * 这里只放 jsdom 证不了的：两个真实浏览器上下文之间的并发编辑、真实 WebSocket
 * 的断网重连、以及输入法组合期间收到远端事务。功能回归留在单测里——那正是切片
 * 文档说的"不做第二套功能回归"。
 *
 * 房间名按用例区分：演示中继的房间在进程内一直留着，共用一个房间会让用例之间
 * 互相看见对方的内容。
 *
 * 断言一律取文档内容而不是编辑区的 `innerText`：远端光标是渲染进编辑区的
 * Decoration，协作者的名字会混进可见文本里，而且两端看到的还不一样。
 */

interface Peers {
  left: Page;
  right: Page;
  close: () => Promise<void>;
}

/** 两个独立的浏览器上下文，各自一份 localStorage 与网络状态。 */
async function twoPeers(browser: Browser, room: string): Promise<Peers> {
  const leftContext = await browser.newContext();
  const rightContext = await browser.newContext();
  const left = await leftContext.newPage();
  const right = await rightContext.newPage();
  await openCollab(left, room, "左");
  await openCollab(right, room, "右");
  return {
    left,
    right,
    close: async () => {
      await leftContext.close();
      await rightContext.close();
    },
  };
}

/**
 * 走能力插件异步回填用的那条通道写一段文字。
 *
 * 不用键盘：编辑区里有远端光标 Decoration 时，点击落点与焦点都不稳定，而这些
 * 用例要验的是同步与组合态，不是点击。真正需要真实按键的地方（组合）仍然走 CDP。
 */
async function insert(page: Page, text: string): Promise<void> {
  await page.evaluate((value) => window.__editorE2E?.dispatchProgrammaticInsert(value), text);
}

/**
 * 一条可以随时拔掉的协同连接。
 *
 * 用 `routeWebSocket` 而不是 `context.setOffline` 或 CDP 的
 * `Network.emulateNetworkConditions`：那两个都只影响新建请求，**已经建立的
 * WebSocket 照常收发**，于是"断网"根本没有发生。这里把连接接管过来，断的是
 * 真的那一条；离线期间的重连尝试也如实失败，客户端的退避因此真的被走到了。
 *
 * 必须在 `goto` 之前装。
 */
async function controllableConnection(page: Page): Promise<{
  cut: () => Promise<void>;
  restore: () => void;
}> {
  let offline = false;
  let current: WebSocketRoute | undefined;
  await page.routeWebSocket(/127\.0\.0\.1:4320/, (ws) => {
    if (offline) {
      ws.close();
      return;
    }
    current = ws;
    ws.connectToServer();
  });
  return {
    cut: async () => {
      offline = true;
      await current?.close();
      current = undefined;
    },
    restore: () => {
      offline = false;
    },
  };
}

test("两个浏览器并发编辑，内容汇合且看得见对方的光标", async ({ browser }, testInfo) => {
  const { left, right, close } = await twoPeers(browser, `merge-${testInfo.testId}`);

  await expect.poll(() => collabState(left).then((state) => state?.peers.length)).toBe(2);
  expect((await collabState(left))?.peers.map((peer) => peer.name).sort()).toEqual(["右", "左"]);

  await insert(left, "左边写的。");
  await expect.poll(() => editorDocumentText(right)).toContain("左边写的。");

  await insert(right, "右边接的。");
  await expect.poll(() => editorDocumentText(left)).toContain("右边接的。");
  await expect.poll(() => editorDocumentText(left)).toBe(await editorDocumentText(right));

  // 远端光标由 awareness 渲染；要有选区才画得出来，因此先让对方点进编辑区。
  await right.locator(EDITOR).click();
  await expect(left.locator(`${EDITOR} .ProseMirror-yjs-cursor`).first()).toBeVisible();

  await close();
});

test("一方断网继续编辑，恢复后合并无丢失", async ({ browser }, testInfo) => {
  const room = `offline-${testInfo.testId}`;
  const leftContext = await browser.newContext();
  const rightContext = await browser.newContext();
  const left = await leftContext.newPage();
  const right = await rightContext.newPage();
  const wire = await controllableConnection(right);
  await openCollab(left, room, "左");
  await openCollab(right, room, "右");
  const close = async () => {
    await leftContext.close();
    await rightContext.close();
  };

  await insert(left, "断网前的内容。");
  await expect.poll(() => editorDocumentText(right)).toContain("断网前的内容。");

  await wire.cut();
  await expect
    .poll(() => collabState(right).then((state) => state?.status), { timeout: 15_000 })
    .toBe("disconnected");

  // 断开的一端仍然可以编辑：绑定不随连接断开而解除，否则离线期间写的东西
  // 根本进不了 Y.Doc，也就谈不上"恢复后合并"。
  expect((await collabState(right))?.bound).toBe(true);
  await insert(right, "离线端写的。");
  await insert(left, "在线端写的。");
  await expect.poll(() => editorDocumentText(right)).not.toContain("在线端写的。");

  wire.restore();

  await expect
    .poll(() => collabState(right).then((state) => state?.status), { timeout: 30_000 })
    .toBe("synced");
  await expect.poll(() => editorDocumentText(right), { timeout: 15_000 }).toContain("在线端写的。");
  await expect.poll(() => editorDocumentText(left), { timeout: 15_000 }).toContain("离线端写的。");
  await expect.poll(() => editorDocumentText(left)).toBe(await editorDocumentText(right));
  // 重连后本端的光标要在对方那里重新出现：awareness 时钟没前进的话它永远回不来。
  await expect.poll(() => collabState(left).then((state) => state?.peers.length)).toBe(2);

  await close();
});

test("中文输入法组合期间收到远端事务，不断字漏字", async ({ browser }, testInfo) => {
  const { left, right, close } = await twoPeers(browser, `ime-${testInfo.testId}`);

  await insert(left, "开头。");
  await expect.poll(() => editorDocumentText(right)).toContain("开头。");

  await right.locator(EDITOR).click();
  const cdp = await right.context().newCDPSession(right);
  await composeText(cdp, ["z", "zh", "zhong"]);
  expect(await right.evaluate(() => window.__editorE2E?.editor.getSnapshot().composing)).toBe(true);

  await insert(left, "远端在组合期间写的。");
  await expect.poll(() => editorDocumentText(left)).toContain("远端在组合期间写的。");

  // 组合还没结束，远端内容不该落到这一端：y-prosemirror 一收到就整篇重建 DOM，
  // 正在打的候选词会当场消失。
  await right.waitForTimeout(500);
  expect(await editorDocumentText(right)).not.toContain("远端在组合期间写的。");

  await commitComposition(cdp, "中文");

  await expect
    .poll(() => editorDocumentText(right), { timeout: 15_000 })
    .toContain("远端在组合期间写的。");
  // 上屏的字一个不少，也没有被远端事务截断。
  expect(await editorDocumentText(right)).toContain("中文");
  await expect.poll(() => editorDocumentText(left), { timeout: 15_000 }).toContain("中文");

  await close();
});
