import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const lintScript = resolve(import.meta.dirname, "../../../scripts/lint-to-dom.mjs");
const invalidFixture = resolve(
  import.meta.dirname,
  "../../../fixtures/lint/to-dom-uses-document.ts",
);

describe("toDOM 的服务端兼容约束", () => {
  it("静态检查会拒绝在 toDOM 中访问 document", () => {
    expect(() =>
      execFileSync(process.execPath, [lintScript, invalidFixture], { stdio: "pipe" }),
    ).toThrow(/toDOM 不能访问 DOM API: document/);
  });
});
