import { describe, expect, it } from "vitest";
import type { EditorPlugin } from "./plugins";
import { createRuntime } from "./runtime";

describe("插件运行时", () => {
  it("持久化名缺 co_ 命名空间时降级启动，不让宿主白屏", () => {
    const invalidPlugin: EditorPlugin = {
      name: "legacy",
      version: "1.0.0",
      namespace: "co_",
      extendSchema: (schema) => schema.addMark("highlight", { toDOM: () => ["mark", 0] }),
    };

    const runtime = createRuntime({ plugins: [invalidPlugin] });

    expect(runtime.getPluginErrors()).toMatchObject([
      { plugin: "legacy", kind: "invalidName", item: "highlight", disabled: true },
    ]);
    // 编辑器本身照常可用。
    expect(runtime.execute("selection.selectAll")).toMatchObject({ ok: true });
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
