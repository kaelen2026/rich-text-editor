import { stringifyEnvelope } from "@kaelen/editor-schema";
import type { EditorEnvelope, PluginError } from "@kaelen/editor-shared-types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditorPlugin } from "./plugins";
import { createRuntime } from "./runtime";

const CARD = "co_card";

/** 一个会在命令里抛错的第三方插件；节点本身是好的。 */
function createFaultyPlugin(): { plugin: EditorPlugin; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    plugin: {
      name: "faulty",
      version: "1.0.0",
      namespace: "co_",
      extendSchema: (schema) =>
        schema.addNode(CARD, { group: "block", content: "inline*", toDOM: () => ["div", 0] }),
      registerCommands: (commands) =>
        commands.add("faulty.crash", {
          run: () => {
            calls += 1;
            throw new Error("第三方插件炸了");
          },
          active: () => false,
        }),
    },
  };
}

function docWithCard(): EditorEnvelope {
  return {
    envelope: 1,
    schemaVersion: 1,
    plugins: { faulty: 1 },
    doc: {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "正文" }] },
        { type: CARD, content: [{ type: "text", text: "卡片" }] },
      ],
    },
    annotations: [],
  };
}

describe("插件错误熔断", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("命令抛错被捕获：返回可判别失败、上报 pluginError、内容一字不丢", () => {
    const { plugin } = createFaultyPlugin();
    const runtime = createRuntime({ plugins: [plugin] });
    const envelope = docWithCard();
    runtime.loadDocument(envelope);
    const before = stringifyEnvelope(runtime.getDocument());

    const errors: PluginError[] = [];
    runtime.subscribe("pluginError", (error) => errors.push(error));

    const result = runtime.execute("faulty.crash");

    expect(result).toMatchObject({ ok: false, reason: "pluginError" });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ plugin: "faulty", kind: "runtimeError", disabled: true });
    expect(errors[0]?.message).toContain("第三方插件炸了");
    expect(stringifyEnvelope(runtime.getDocument())).toBe(before);
  });

  it("60 秒内第 3 次抛错触发熔断，之后不再进入插件代码", () => {
    const { plugin, calls } = createFaultyPlugin();
    const runtime = createRuntime({ plugins: [plugin] });
    const errors: PluginError[] = [];
    runtime.subscribe("pluginError", (error) => errors.push(error));

    runtime.execute("faulty.crash");
    vi.setSystemTime(20_000);
    runtime.execute("faulty.crash");
    vi.setSystemTime(40_000);
    runtime.execute("faulty.crash");

    expect(calls()).toBe(3);
    expect(errors.map((error) => error.tripped)).toEqual([false, false, true]);

    // 熔断后命令直接拒绝，插件代码不再被调用。
    vi.setSystemTime(41_000);
    expect(runtime.execute("faulty.crash")).toMatchObject({ ok: false, reason: "disabled" });
    expect(calls()).toBe(3);
  });

  it("超出 60 秒窗口的失败不累计", () => {
    const { plugin, calls } = createFaultyPlugin();
    const runtime = createRuntime({ plugins: [plugin] });

    runtime.execute("faulty.crash");
    vi.setSystemTime(30_000);
    runtime.execute("faulty.crash");
    // 第一次失败已滑出窗口，这次只是窗口内的第 2 次。
    vi.setSystemTime(70_000);
    runtime.execute("faulty.crash");

    expect(calls()).toBe(3);
    vi.setSystemTime(71_000);
    runtime.execute("faulty.crash");
    expect(calls()).toBe(4);
  });

  it("熔断后插件的节点仍在 Schema 中，已有内容照常显示与保存", () => {
    const { plugin } = createFaultyPlugin();
    const runtime = createRuntime({ plugins: [plugin] });
    const envelope = docWithCard();
    runtime.loadDocument(envelope);
    const before = stringifyEnvelope(runtime.getDocument());

    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.execute("faulty.crash");
    }

    expect(stringifyEnvelope(runtime.getDocument())).toBe(before);
    // 其余内容照常可编辑。
    expect(runtime.execute("selection.selectAll")).toMatchObject({ ok: true });
  });

  it("queryCommand 抛错同样被兜住，工具栏不会整页崩掉", () => {
    const plugin: EditorPlugin = {
      name: "faulty",
      version: "1.0.0",
      namespace: "co_",
      registerCommands: (commands) =>
        commands.add("faulty.state", {
          run: () => ({ ok: true }),
          active: () => {
            throw new Error("active 炸了");
          },
        }),
    };
    const runtime = createRuntime({ plugins: [plugin] });
    const errors: PluginError[] = [];
    runtime.subscribe("pluginError", (error) => errors.push(error));

    expect(runtime.queryCommand("faulty.state")).toEqual({ enabled: false, active: false });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ plugin: "faulty", kind: "runtimeError" });
  });

  it("核心命令不受插件熔断影响", () => {
    const { plugin } = createFaultyPlugin();
    const runtime = createRuntime({ plugins: [plugin] });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      runtime.execute("faulty.crash");
    }

    expect(runtime.queryCommand("format.bold").enabled).toBe(true);
  });
});

describe("插件诊断上报", () => {
  it("启动期冲突可在订阅之前取回，并且引用稳定", () => {
    const runtime = createRuntime({
      plugins: [
        { name: "broken", version: "1.0.0", namespace: "co_", dependsOn: ["missing"] },
        { name: "healthy", version: "1.0.0", namespace: "co_" },
      ],
    });

    const errors = runtime.getPluginErrors();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ plugin: "broken", kind: "missingDependency" });
    // useSyncExternalStore 要求快照可缓存：没有新错误时必须是同一个引用。
    expect(runtime.getPluginErrors()).toBe(errors);
  });

  it("被禁用的插件不注册 Schema，其内容走未知节点兜底且原样写回", () => {
    const runtime = createRuntime({
      plugins: [
        {
          name: "faulty",
          version: "1.0.0",
          namespace: "co_",
          dependsOn: ["missing"],
          extendSchema: (schema) =>
            schema.addNode(CARD, { group: "block", content: "inline*", toDOM: () => ["div", 0] }),
        },
      ],
    });

    const envelope = docWithCard();
    const result = runtime.loadDocument(envelope);

    expect(result.ok).toBe(true);
    expect(result.unknownNodes).toEqual([CARD]);
    expect(stringifyEnvelope(runtime.getDocument())).toBe(stringifyEnvelope(envelope));
  });
});
