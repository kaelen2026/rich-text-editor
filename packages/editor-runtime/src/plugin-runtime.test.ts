import { describe, expect, it } from "vitest";
import type { EditorPlugin } from "./plugins";
import { createRuntime } from "./runtime";

describe("插件运行时", () => {
  it("拒绝没有 co_ 命名空间的持久化标记", () => {
    const invalidPlugin: EditorPlugin = {
      name: "legacy",
      version: "1.0.0",
      namespace: "co_",
      extendSchema: (schema) => schema.addMark("highlight", { toDOM: () => ["mark", 0] }),
    };

    expect(() => createRuntime({ plugins: [invalidPlugin] })).toThrow(/co_/);
  });

  it("在扩展 schema 前按依赖顺序启动插件", () => {
    const calls: string[] = [];
    const base: EditorPlugin = {
      name: "base",
      version: "1.0.0",
      namespace: "co_",
      extendSchema: () => calls.push("base"),
    };
    const dependent: EditorPlugin = {
      name: "dependent",
      version: "1.0.0",
      namespace: "co_",
      dependsOn: ["base"],
      extendSchema: () => calls.push("dependent"),
    };

    createRuntime({ plugins: [dependent, base] });

    expect(calls).toEqual(["base", "dependent"]);
  });
});
