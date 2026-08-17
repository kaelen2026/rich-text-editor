import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../scripts/api-surface.mjs");
const leakyFixture = resolve(import.meta.dirname, "../fixtures/lint/api-leaks-prosemirror.ts");

/**
 * 检查自身也要被检查。
 *
 * 一份只会打印"通过"的检查和没有检查是一回事，而这种失效完全无声——快照文件还在、
 * CI 还是绿的。拿一个真的泄漏了 ProseMirror 类型的入口喂给它，看它是不是真的会响。
 */
describe("API 表面检查", () => {
  it("公开入口直接暴露 ProseMirror 类型时失败", () => {
    expect(() =>
      execFileSync(process.execPath, [script, "--entry", leakyFixture], { stdio: "pipe" }),
    ).toThrow(/直接暴露了 ProseMirror 类型 ProseMirrorNode（来自 prosemirror-model）/);
  });

  it("当前的公开表面与已录快照一致", () => {
    // 这一条在 `pnpm check` 里也跑；放进测试是为了本地改接口时立刻看见，
    // 而不是等到提交前那一步。
    expect(() => execFileSync(process.execPath, [script], { stdio: "pipe" })).not.toThrow();
  });
});
