import { expect, test } from "@playwright/test";
import {
  commitComposition,
  composeText,
  EDITOR,
  editorText,
  isComposing,
  openPlayground,
} from "./support";

/**
 * 输入法组合态契约（方案 §9.6）的真实浏览器验收，对应 §16.4 的三条。
 *
 * jsdom 里这些全部验不了：`composing` 标志能被手动置位，但真正会出问题的是
 * "浏览器在组合期间自己改了 DOM，而模型不知道"——那要有真实的 IME 事件才会发生。
 */
test.describe("组合态", () => {
  test("组合态中触发输入规则：不转换块类型，也不断字漏字", async ({ page }) => {
    await openPlayground(page);
    const cdp = await page.context().newCDPSession(page);

    // 行首输入 `- `：非组合态下这是无序列表的输入规则。
    await composeText(cdp, ["-", "- ", "- j", "- ji", "- jian"]);
    expect(await isComposing(page)).toBe(true);
    // 组合还没结束，块类型必须一动不动——这一步转成列表，候选词就落进列表项里了。
    await expect(page.locator(`${EDITOR} ul`)).toHaveCount(0);

    await commitComposition(cdp, "减号");
    await expect.poll(() => isComposing(page)).toBe(false);

    // 上屏后仍然是段落，文字一个不多一个不少。
    await expect(page.locator(`${EDITOR} ul`)).toHaveCount(0);
    expect(await editorText(page)).toBe("减号");
  });

  test("组合态中的程序化命令被拒绝，组合本身不受影响", async ({ page }) => {
    await openPlayground(page);
    const cdp = await page.context().newCDPSession(page);

    await composeText(cdp, ["n", "ni", "nih", "niha", "nihao"]);
    const rejected = await page.evaluate(() => window.__editorE2E?.editor.execute("format.bold"));
    // §9.6 第 5 条：组合期间 execute() 如实返回 composing，由 UI 决定禁用还是排队。
    expect(rejected).toEqual({ ok: false, reason: "composing" });

    await commitComposition(cdp, "你好");
    await expect.poll(() => isComposing(page)).toBe(false);
    expect(await editorText(page)).toBe("你好");
    // 命令被拒绝意味着它一点都没生效，而不是"生效了一半"。
    await expect(page.locator(`${EDITOR} strong`)).toHaveCount(0);
  });

  test("组合态中的程序化事务被挂起，compositionend 后按映射后的位置应用", async ({ page }) => {
    await openPlayground(page);
    const cdp = await page.context().newCDPSession(page);

    await page.keyboard.type("尾部");
    // 光标回到段首：随后组合上屏的文字会把回填的目标位置整体往后推，
    // 冲刷时必须按映射后的位置落。
    await page.keyboard.press("Home");

    await composeText(cdp, ["z", "zh", "zho", "zhon", "zhong"]);
    expect(await isComposing(page)).toBe(true);

    // 能力插件的异步回填走 SessionBridge。它此刻必须进不了文档：进去就会
    // 打断正在组合的那个文本节点。
    await page.evaluate(() => window.__editorE2E?.dispatchProgrammaticInsert("【回填】"));
    await page.waitForTimeout(200);
    expect(await isComposing(page)).toBe(true);
    expect(await editorText(page)).not.toContain("【回填】");

    await commitComposition(cdp, "中间");
    await expect.poll(() => isComposing(page)).toBe(false);

    // 冲刷之后回填才落地，且落在映射后的位置——段尾，而不是被"中间"顶开的旧位置。
    await expect.poll(() => editorText(page)).toBe("中间尾部【回填】");
  });

  test("组合态中覆盖当前文本节点的 Decoration 被冻结", async ({ page }) => {
    await openPlayground(page);
    const cdp = await page.context().newCDPSession(page);

    await page.keyboard.type("底稿");
    const probe = page.locator(`${EDITOR} .e2e-probe`).first();
    const before = await probe.getAttribute("data-probe-render");

    await composeText(cdp, ["p", "pi", "pin", "piny", "pinyi", "pinyin"]);
    expect(await isComposing(page)).toBe(true);

    // §9.6 第 3 条：组合期间冻结覆盖当前文本节点的 Decoration。让它更新一次，
    // ProseMirror 就会重建那段 DOM，而那段 DOM 此刻归输入法管——候选文本会被抹掉。
    await expect(probe).toHaveAttribute("data-probe-render", before as string);

    await commitComposition(cdp, "拼音");
    await expect.poll(() => isComposing(page)).toBe(false);
    expect(await editorText(page)).toBe("底稿拼音");

    // 组合结束后必须恢复更新，否则冻结就成了永久失效。
    await page.keyboard.type("后续");
    await expect(probe).not.toHaveAttribute("data-probe-render", before as string);
  });
});
