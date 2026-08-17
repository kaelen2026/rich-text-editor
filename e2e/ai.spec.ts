import { expect, type Page, test } from "@playwright/test";
import { commitComposition, composeText, EDITOR, openPlayground } from "./support";

/**
 * AI 回填的真实浏览器验收（方案 §9.5、§9.6）。
 *
 * 只放 jsdom 证不了的那一条：回填是典型的程序化事务，组合态期间必须被挂起，
 * 并在 `compositionend` 之后按**映射后**的位置落地。S25 已经证明这条路径在
 * jsdom 里验不出来——那里没有"从 DOM 读回模型"这一步，同步冲刷看上去一直是对的。
 *
 * 位置迁移、目标消失丢弃、撤销语义都在插件的单测里，这里不做第二套功能回归。
 */

/**
 * 文档内容，而不是编辑区的 `innerText`。
 *
 * 生成中的提示是渲染进编辑区的 Decoration，它的文字会混进 `innerText`；
 * 用它断言"结果有没有落地"会把提示本身也算进去。
 */
function documentText(page: Page): Promise<string> {
  return page.evaluate(() => window.__editorE2E?.editor.getMarkdown() ?? "");
}

test("组合态期间到达的 AI 回填被挂起，组合结束后落到映射后的位置", async ({ page }) => {
  await openPlayground(page);
  const cdp = await page.context().newCDPSession(page);

  await page.keyboard.type("第一段");
  // 选中刚打的三个字，作为改写目标。ProseMirror 是异步把 DOM 选区读回模型的，
  // 按完键立刻发命令会撞上那个空档，因此等模型自己确认。
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press("Shift+ArrowLeft");
  }
  await expect
    .poll(() => page.evaluate(() => window.__editorE2E?.editor.getSelectionState().empty))
    .toBe(false);

  expect(await page.evaluate(() => window.__editorE2E?.editor.execute("ai.rewrite"))).toEqual({
    ok: true,
  });
  await expect(page.locator(`${EDITOR} [data-ai-status="generating"]`).first()).toBeVisible();

  // 请求在飞的同时改文档结构：目标区间从这里开始就和发起时算的那对数字不同了。
  // 同样要等模型看到收拢后的光标——它还以为选区在的话，回车会把选区替换掉。
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => page.evaluate(() => window.__editorE2E?.editor.getSelectionState().empty))
    .toBe(true);
  await page.keyboard.press("Enter");

  await composeText(cdp, ["z", "zh", "zhong"]);
  expect(await page.evaluate(() => window.__editorE2E?.editor.getSnapshot().composing)).toBe(true);

  // 结果在组合进行到一半时到达。
  expect(
    await page.evaluate(() => window.__editorE2E?.settleAi({ ok: true, text: "改写后的第一段" })),
  ).toBe(true);
  await page.waitForTimeout(500);

  // 组合还没结束，回填不许落地——否则 ProseMirror 会重建那段 DOM，候选字消失。
  expect(await documentText(page)).not.toContain("改写后的第一段");
  expect(await documentText(page)).toContain("第一段");

  await commitComposition(cdp, "中文");

  await expect.poll(() => documentText(page), { timeout: 15_000 }).toContain("改写后的第一段");
  // 上屏的字一个不少，也没有被回填截断。
  expect(await documentText(page)).toContain("中文");
  // 回填落在第一段，没有跑到用户刚打字的那一段里去。
  expect((await documentText(page)).split("\n\n")[0]).toBe("改写后的第一段");
});
