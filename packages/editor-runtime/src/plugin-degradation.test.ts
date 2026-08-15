import { coreCommands } from "@kaelen/editor-pm-adapter";
import type { CoreNodeSpec } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { type EditorPlugin, resolvePlugins } from "./plugins";

/** 一个合法的块节点 spec，内容与本文件断言无关。 */
const blockSpec: CoreNodeSpec = { group: "block", content: "inline*", toDOM: () => ["div", 0] };

function plugin(name: string, extra: Partial<EditorPlugin> = {}): EditorPlugin {
  return { name, version: "1.0.0", namespace: "co_", ...extra };
}

function errorFor(plugin: string, errors: ReturnType<typeof resolvePlugins>["errors"]) {
  return errors.find((error) => error.plugin === plugin);
}

function enabledNames(resolution: ReturnType<typeof resolvePlugins>): string[] {
  return resolution.enabled.map((plugin) => plugin.name);
}

describe("插件冲突降级", () => {
  it("环上插件全部禁用，环外插件照常启动", () => {
    const resolution = resolvePlugins([
      plugin("a", { dependsOn: ["b"] }),
      plugin("b", { dependsOn: ["a"] }),
      plugin("healthy"),
    ]);

    expect(enabledNames(resolution)).toEqual(["healthy"]);
    expect(errorFor("a", resolution.errors)).toMatchObject({ kind: "cycle", disabled: true });
    expect(errorFor("b", resolution.errors)).toMatchObject({ kind: "cycle", disabled: true });
  });

  it("缺失依赖时该插件禁用，依赖它的插件递归禁用", () => {
    const resolution = resolvePlugins([
      plugin("leaf", { dependsOn: ["missing"] }),
      plugin("middle", { dependsOn: ["leaf"] }),
      plugin("top", { dependsOn: ["middle"] }),
      plugin("healthy"),
    ]);

    expect(enabledNames(resolution)).toEqual(["healthy"]);
    expect(errorFor("leaf", resolution.errors)).toMatchObject({
      kind: "missingDependency",
      item: "missing",
      disabled: true,
    });
    expect(errorFor("top", resolution.errors)).toMatchObject({
      kind: "missingDependency",
      item: "middle",
    });
  });

  it("节点重名时先注册者胜出，后注册者整体禁用", () => {
    const resolution = resolvePlugins([
      plugin("first", { extendSchema: (schema) => schema.addNode("co_card", blockSpec) }),
      plugin("second", {
        extendSchema: (schema) => {
          schema.addNode("co_badge", blockSpec);
          schema.addNode("co_card", blockSpec);
        },
      }),
    ]);

    expect(enabledNames(resolution)).toEqual(["first"]);
    expect(resolution.nodes.co_card).toBeDefined();
    // 后注册者已登记的部分必须一并回滚，否则半个插件的 Schema 会留在文档里。
    expect(resolution.nodes.co_badge).toBeUndefined();
    expect(errorFor("second", resolution.errors)).toMatchObject({
      kind: "duplicateNode",
      item: "co_card",
      conflictWith: "first",
      disabled: true,
    });
  });

  it("与冻结核心集重名时冲突对方记为 core", () => {
    const resolution = resolvePlugins([
      plugin("shadow", { extendSchema: (schema) => schema.addMark("strong", {}) }),
    ]);

    expect(enabledNames(resolution)).toEqual([]);
    expect(errorFor("shadow", resolution.errors)).toMatchObject({
      kind: "duplicateMark",
      item: "strong",
      conflictWith: "core",
    });
  });

  it("持久化名缺 co_ 前缀时降级启动而不是抛错", () => {
    const resolution = resolvePlugins([
      plugin("legacy", { extendSchema: (schema) => schema.addMark("highlight", {}) }),
      plugin("healthy"),
    ]);

    expect(enabledNames(resolution)).toEqual(["healthy"]);
    expect(errorFor("legacy", resolution.errors)).toMatchObject({
      kind: "invalidName",
      item: "highlight",
      disabled: true,
    });
  });

  it("插件入口点抛错时禁用该插件，其余插件照常启动", () => {
    const resolution = resolvePlugins([
      plugin("boom", {
        extendSchema: () => {
          throw new Error("插件自己炸了");
        },
      }),
      plugin("healthy"),
    ]);

    expect(enabledNames(resolution)).toEqual(["healthy"]);
    expect(errorFor("boom", resolution.errors)).toMatchObject({
      kind: "runtimeError",
      disabled: true,
    });
    expect(errorFor("boom", resolution.errors)?.message).toContain("插件自己炸了");
  });

  it("插件重名时后注册者禁用", () => {
    const resolution = resolvePlugins([plugin("dup"), plugin("dup")]);

    expect(enabledNames(resolution)).toEqual(["dup"]);
    expect(errorFor("dup", resolution.errors)).toMatchObject({
      kind: "duplicatePlugin",
      disabled: true,
    });
  });
});

describe("插件命令冲突", () => {
  const noop = { run: () => ({ ok: true }), active: () => false };

  it("命令重名时只忽略这一条命令，插件其余能力保留", () => {
    const resolution = resolvePlugins([
      plugin("first", { registerCommands: (commands) => commands.add("first.go", noop) }),
      plugin("second", {
        registerCommands: (commands) => {
          commands.add("second.go", noop);
          commands.add("first.go", noop);
        },
      }),
    ]);

    expect(enabledNames(resolution)).toEqual(["first", "second"]);
    expect(resolution.commands.get("second.go")?.owner).toBe("second");
    expect(resolution.commands.get("first.go")?.owner).toBe("first");
    expect(errorFor("second", resolution.errors)).toMatchObject({
      kind: "duplicateCommand",
      item: "first.go",
      conflictWith: "first",
      disabled: false,
    });
  });

  it("插件不能覆盖核心命令：核心实现胜出并上报冲突", () => {
    const resolution = resolvePlugins([
      plugin("evil", {
        registerCommands: (commands) => commands.add("format.bold", noop),
      }),
    ]);

    const bold = resolution.commands.get("format.bold");
    expect(bold?.owner).toBeUndefined();
    expect(bold?.command).toBe(coreCommands["format.bold"]);
    expect(errorFor("evil", resolution.errors)).toMatchObject({
      kind: "duplicateCommand",
      item: "format.bold",
      conflictWith: "core",
      disabled: false,
    });
  });

  it("命令名必须以插件名打头，否则只丢这一条命令", () => {
    const resolution = resolvePlugins([
      plugin("link", {
        registerCommands: (commands) => {
          commands.add("link.set", noop);
          commands.add("format.underline", noop);
          commands.add("bare", noop);
        },
      }),
    ]);

    expect(enabledNames(resolution)).toEqual(["link"]);
    expect(resolution.commands.get("link.set")?.owner).toBe("link");
    // S6 已将 underline 变为核心命令；冲突插件不能覆盖它。
    expect(resolution.commands.get("format.underline")?.owner).toBeUndefined();
    expect(resolution.commands.has("bare")).toBe(false);
    expect(
      resolution.errors.filter((error) => error.kind === "invalidName").map((error) => error.item),
    ).toEqual(["bare"]);
  });
});
