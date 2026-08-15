import type { SessionCommand } from "@kaelen/editor-pm-adapter";
import { coreMarks, coreNodes } from "@kaelen/editor-schema";
import type { CoreMarkSpec, CoreNodeSpec } from "@kaelen/editor-shared-types";

/** 插件可扩展的 Schema 注册表；持久化名称在这里集中校验。 */
export interface SchemaBuilder {
  addNode(name: string, spec: CoreNodeSpec): void;
  addMark(name: string, spec: CoreMarkSpec): void;
}

export interface CommandRegistry {
  add(name: string, command: SessionCommand): void;
}

/** 编辑器功能插件的最小运行时契约（方案 §8.3）。 */
export interface EditorPlugin {
  name: string;
  version: string;
  /** 插件持久化节点/标记使用的全局命名空间；当前固定为 `co_`。 */
  namespace: "co_";
  /**
   * 该插件贡献的文档结构版本，写进信封的 `plugins`。与包版本（semver 的
   * `version`）不同：它是持久化数据的版本，由插件自己的迁移函数推进。
   */
  structureVersion?: number;
  dependsOn?: string[];
  extendSchema?(schema: SchemaBuilder): void;
  registerCommands?(commands: CommandRegistry): void;
}

export interface RegisteredPluginCapabilities {
  nodes: Record<string, CoreNodeSpec>;
  marks: Record<string, CoreMarkSpec>;
  commands: Map<string, SessionCommand>;
}

/**
 * 按依赖拓扑顺序收集插件能力。S4 对配置错误明确失败；S5 再把冲突转为可诊断降级。
 */
export function collectPluginCapabilities(plugins: EditorPlugin[]): RegisteredPluginCapabilities {
  const ordered = orderPlugins(plugins);
  const nodes: Record<string, CoreNodeSpec> = {};
  const marks: Record<string, CoreMarkSpec> = {};
  const commands = new Map<string, SessionCommand>();

  const schema: SchemaBuilder = {
    addNode(name, spec) {
      assertPluginSchemaName(name, "节点");
      if (nodes[name] || coreNodes[name]) {
        throw new Error(`重复注册节点：${name}`);
      }
      nodes[name] = spec;
    },
    addMark(name, spec) {
      assertPluginSchemaName(name, "标记");
      if (marks[name] || coreMarks[name]) {
        throw new Error(`重复注册标记：${name}`);
      }
      marks[name] = spec;
    },
  };
  const commandRegistry: CommandRegistry = {
    add(name, command) {
      if (!name.includes(".")) {
        throw new Error(`插件命令必须以插件名为前缀：${name}`);
      }
      if (commands.has(name)) {
        throw new Error(`重复注册命令：${name}`);
      }
      commands.set(name, command);
    },
  };

  for (const plugin of ordered) {
    plugin.extendSchema?.(schema);
    plugin.registerCommands?.(commandRegistry);
  }
  return { nodes, marks, commands };
}

function assertPluginSchemaName(name: string, kind: string): void {
  if (!name.startsWith("co_")) {
    throw new Error(`插件${kind}必须使用 co_ 命名空间：${name}`);
  }
}

function orderPlugins(plugins: EditorPlugin[]): EditorPlugin[] {
  const byName = new Map<string, EditorPlugin>();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      throw new Error(`重复插件名：${plugin.name}`);
    }
    byName.set(plugin.name, plugin);
  }

  const ordered: EditorPlugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (plugin: EditorPlugin): void => {
    if (visited.has(plugin.name)) {
      return;
    }
    if (visiting.has(plugin.name)) {
      throw new Error(`插件依赖存在循环：${plugin.name}`);
    }
    visiting.add(plugin.name);
    for (const dependency of plugin.dependsOn ?? []) {
      const required = byName.get(dependency);
      if (!required) {
        throw new Error(`插件 ${plugin.name} 缺少依赖：${dependency}`);
      }
      visit(required);
    }
    visiting.delete(plugin.name);
    visited.add(plugin.name);
    ordered.push(plugin);
  };
  for (const plugin of plugins) {
    visit(plugin);
  }
  return ordered;
}
