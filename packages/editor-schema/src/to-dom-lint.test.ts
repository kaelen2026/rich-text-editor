import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const lintScript = resolve(import.meta.dirname, "../../../scripts/lint-to-dom.mjs");
const fixture = (name: string): string =>
  resolve(import.meta.dirname, `../../../fixtures/lint/${name}.ts`);

describe("序列化函数的服务端兼容约束", () => {
  it("静态检查会拒绝在 toDOM 中访问 document", () => {
    expect(() =>
      execFileSync(process.execPath, [lintScript, fixture("to-dom-uses-document")], {
        stdio: "pipe",
      }),
    ).toThrow(/toDOM 不能访问 DOM API: document/);
  });

  // Markdown 序列化与 HTML 渲染共用同一条服务端约束：两者都要能在纯 Node 里跑。
  it("静态检查会拒绝在 toMarkdown 中访问 document", () => {
    expect(() =>
      execFileSync(process.execPath, [lintScript, fixture("to-markdown-uses-document")], {
        stdio: "pipe",
      }),
    ).toThrow(/toMarkdown 不能访问 DOM API: document/);
  });
});
