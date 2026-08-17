import { expect, test } from "@playwright/test";
import { EDITOR, editorText, openPlayground, pasteHTML } from "./support";

/**
 * "inert 解析"这条安全边界（方案 §11.3、§16.3）的判据只有真实浏览器答得了：
 * 把不可信 HTML 交给活文档（`innerHTML`）与交给 `DOMParser` 的**代码差别很小，
 * 后果差别是会不会替对方发请求**。jsdom 两种写法都不发请求，因此它证明不了任何
 * 东西——这条用例必须在浏览器里跑。
 */
const TRACKING_HTML = `
  <div>
    <h2>外部文章标题</h2>
    <p>正文一段，带一个<a href="https://example.test/ok">正常链接</a>。</p>
    <p><a href="javascript:window.__pwned=1">危险链接</a></p>
    <img src="https://tracker.test/pixel.gif?uid=42" width="1" height="1">
    <img src="https://tracker.test/second.png">
    <link rel="stylesheet" href="https://tracker.test/style.css">
    <script src="https://tracker.test/evil.js"></script>
    <script>window.__pwned = 1;</script>
    <p onclick="window.__pwned=1">带事件属性的段落</p>
    <iframe src="https://tracker.test/frame.html"></iframe>
  </div>
`;

test.describe("外部 HTML 粘贴", () => {
  test("解析阶段不产生任何网络请求", async ({ page }) => {
    const external: string[] = [];
    // 拦下所有非本地开发服务器的请求。既记账也不让它真的出去——万一哪天真发了，
    // 用例不该顺手把数据送到第三方。
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url.startsWith("http://127.0.0.1:") || url.startsWith("data:")) {
        await route.continue();
        return;
      }
      external.push(url);
      await route.abort();
    });

    await openPlayground(page);
    external.length = 0;

    await pasteHTML(page, TRACKING_HTML);
    await expect.poll(() => editorText(page)).toContain("外部文章标题");
    // 给渲染和任何迟到的请求留出窗口，再看账本。
    await page.waitForTimeout(500);

    expect(external).toEqual([]);
  });

  test("脚本不执行、事件属性与危险协议被丢掉，语义结构保留", async ({ page }) => {
    await openPlayground(page);
    await pasteHTML(page, TRACKING_HTML);
    await expect.poll(() => editorText(page)).toContain("外部文章标题");

    // 内联 script、外链 script、onclick 三条路径都没跑起来。
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.locator(`${EDITOR} [onclick]`)).toHaveCount(0);
    await expect(page.locator(`${EDITOR} script`)).toHaveCount(0);
    await expect(page.locator(`${EDITOR} iframe`)).toHaveCount(0);
    // 图片不进文档：远端图片要先经服务端转存（§11.3.1）。
    await expect(page.locator(`${EDITOR} img`)).toHaveCount(0);

    // 危险链接不生成 a 标签，但它的文字还在——丢格式不丢内容。
    await expect(page.locator(`${EDITOR} a[href^="javascript:"]`)).toHaveCount(0);
    expect(await editorText(page)).toContain("危险链接");

    // 该保的语义照常保住，否则"安全"就是靠把内容清空换来的。
    await expect(page.locator(`${EDITOR} h2`)).toHaveText("外部文章标题");
    await expect(page.locator(`${EDITOR} a[href="https://example.test/ok"]`)).toHaveText(
      "正常链接",
    );
  });
});
