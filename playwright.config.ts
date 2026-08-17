import { defineConfig, devices } from "@playwright/test";

const PORT = 4319;
const COLLAB_PORT = 4320;

/**
 * 真实浏览器验收（方案 §16.3、§16.4）。
 *
 * 这里只放 jsdom 验不了的东西，不做第二套功能回归：
 *
 * - 输入法组合态。jsdom 里没有真实的 composition 事件时序，`compositionstart` 与
 *   `beforeinput`/`textInput` 的先后、组合中途的 DOM 变化都得靠浏览器自己产生。
 *   用例通过 CDP 的 `Input.imeSetComposition` 驱动，那是唯一能造出真实组合态的接口。
 * - 粘贴解析阶段的网络请求数。"inert 解析"这条安全约束的判据是"浏览器有没有为它
 *   发请求"，只有真实浏览器答得了。
 * - 协同（§17）。两个真实浏览器上下文、一条真实 WebSocket、真实的断网重连：
 *   provider 的重连、awareness 清场、以及"组合期间收到远端事务"这三条，
 *   在 jsdom 里要么造不出来，要么造出来的是另一回事。
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // 用 dev server 而不是先 build 再 preview：这些用例断言的是运行时行为，
      // 产物打包与它们无关，省下的构建时间在 CI 上是实打实的。
      // 显式绑 127.0.0.1：vite 默认只监听 localhost，在 IPv6 优先的机器上会解析到
      // ::1，而 baseURL 用的是 IPv4 地址，等待就永远等不到。
      command: `pnpm --filter @kaelen/playground dev --port ${PORT} --strictPort --host 127.0.0.1`,
      url: `http://127.0.0.1:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      // 协同演示中继。它是 apps/ 下的一个例子，不是产品的一部分；用例要的只是
      // "一条真实的 WebSocket 和一个真实的房间"。
      command: `pnpm demo:collab-server`,
      url: `http://127.0.0.1:${COLLAB_PORT}/health`,
      env: { COLLAB_PORT: String(COLLAB_PORT) },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
