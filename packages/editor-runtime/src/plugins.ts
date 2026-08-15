import { coreCommands, type SessionCommand } from "@kaelen/editor-pm-adapter";
import { coreMarks, coreNodes } from "@kaelen/editor-schema";
import type {
  CoreMarkSpec,
  CoreNodeSpec,
  PluginError,
  PluginErrorKind,
} from "@kaelen/editor-shared-types";

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

/** 已注册的命令及其归属。核心命令没有 `owner`，因此永远不会被熔断。 */
export interface RegisteredCommand {
  command: SessionCommand;
  owner?: string;
}

export interface PluginResolution {
  /** 真正启用的插件，按依赖拓扑排序。 */
  enabled: EditorPlugin[];
  nodes: Record<string, CoreNodeSpec>;
  marks: Record<string, CoreMarkSpec>;
  /** 命令名 → 实现。核心命令先入表，插件因此无法覆盖它们。 */
  commands: Map<string, RegisteredCommand>;
  /** 全部降级记录，按发生顺序。 */
  errors: PluginError[];
}

const CORE = "core";

/**
 * 按依赖拓扑顺序收集插件能力，冲突一律降级启动而不是抛错。
 *
 * 一个第三方插件重名不应该让宿主应用白屏（方案 §8.3）：能装的照常装，装不上的
 * 留下可诊断记录——谁、因为什么、和谁冲突。
 */
export function resolvePlugins(plugins: EditorPlugin[]): PluginResolution {
  const errors: PluginError[] = [];
  const nodes: Record<string, CoreNodeSpec> = {};
  const marks: Record<string, CoreMarkSpec> = {};
  const commands = new Map<string, RegisteredCommand>();
  // 核心命令先占位：后面所有重名检查因此对"覆盖核心命令"同样生效。
  for (const [name, command] of Object.entries(coreCommands)) {
    commands.set(name, { command });
  }

  const nodeOwner = new Map<string, string>();
  const markOwner = new Map<string, string>();
  const disabled = new Set<string>();
  const enabled: EditorPlugin[] = [];

  const report = (error: PluginError): void => {
    errors.push(error);
    if (error.disabled) {
      disabled.add(error.plugin);
    }
  };

  for (const plugin of orderPlugins(plugins, report)) {
    const brokenDependency = (plugin.dependsOn ?? []).find((name) => disabled.has(name));
    if (brokenDependency) {
      report(
        fatal(plugin.name, "missingDependency", {
          item: brokenDependency,
          conflictWith: brokenDependency,
          message: `插件 ${plugin.name} 的依赖 ${brokenDependency} 不可用，已一并禁用`,
        }),
      );
      continue;
    }

    const draft = stagePlugin(plugin, { nodes, marks, commands, nodeOwner, markOwner });
    if (!draft.ok) {
      report(draft.error);
      continue;
    }

    for (const [name, spec] of Object.entries(draft.nodes)) {
      nodes[name] = spec;
      nodeOwner.set(name, plugin.name);
    }
    for (const [name, spec] of Object.entries(draft.marks)) {
      marks[name] = spec;
      markOwner.set(name, plugin.name);
    }
    for (const [name, command] of draft.commands) {
      commands.set(name, { command, owner: plugin.name });
    }
    for (const error of draft.warnings) {
      report(error);
    }
    enabled.push(plugin);
  }

  return { enabled, nodes, marks, commands, errors };
}

interface StageContext {
  nodes: Record<string, CoreNodeSpec>;
  marks: Record<string, CoreMarkSpec>;
  commands: Map<string, RegisteredCommand>;
  nodeOwner: Map<string, string>;
  markOwner: Map<string, string>;
}

type StageResult =
  | {
      ok: true;
      nodes: Record<string, CoreNodeSpec>;
      marks: Record<string, CoreMarkSpec>;
      commands: Array<[string, SessionCommand]>;
      /** 不致命的降级：这一条命令被忽略，插件其余能力保留。 */
      warnings: PluginError[];
    }
  | { ok: false; error: PluginError };

/**
 * 先把插件的贡献登记到暂存区，全部通过才提交。
 *
 * 半途失败必须整体回滚：只提交一半的 Schema 会让文档里出现"这个插件的节点在、
 * 那个不在"的状态，之后既没法渲染也没法迁移。
 */
function stagePlugin(plugin: EditorPlugin, context: StageContext): StageResult {
  const draftNodes: Record<string, CoreNodeSpec> = {};
  const draftMarks: Record<string, CoreMarkSpec> = {};
  const draftCommands: Array<[string, SessionCommand]> = [];
  const warnings: PluginError[] = [];

  // 重名先于命名空间判断：插件试图占用 `strong` 时，"和冻结核心集冲突"
  // 比"名字不合规"更能说明问题，也更接近宿主要展示的话。
  const schema: SchemaBuilder = {
    addNode(name, spec) {
      const owner = coreNodes[name]
        ? CORE
        : (context.nodeOwner.get(name) ?? ownerOf(draftNodes, name, plugin));
      if (owner) {
        throw new PluginConflict("duplicateNode", name, owner, "节点");
      }
      assertNamespace(plugin, name, "节点");
      draftNodes[name] = spec;
    },
    addMark(name, spec) {
      const owner = coreMarks[name]
        ? CORE
        : (context.markOwner.get(name) ?? ownerOf(draftMarks, name, plugin));
      if (owner) {
        throw new PluginConflict("duplicateMark", name, owner, "标记");
      }
      assertNamespace(plugin, name, "标记");
      draftMarks[name] = spec;
    },
  };

  const registry: CommandRegistry = {
    add(name, command) {
      // 先判重名再判前缀：插件试图覆盖 `format.bold` 时，"和核心命令冲突"
      // 比"名字不合规"更能说明问题。
      const existing = context.commands.get(name);
      if (existing) {
        warnings.push(
          warning(plugin.name, "duplicateCommand", {
            item: name,
            conflictWith: existing.owner ?? CORE,
            message: `插件 ${plugin.name} 的命令 ${name} 与${describeOwner(existing.owner)}重名，该命令被忽略`,
          }),
        );
        return;
      }
      if (draftCommands.some(([registered]) => registered === name)) {
        warnings.push(
          warning(plugin.name, "duplicateCommand", {
            item: name,
            conflictWith: plugin.name,
            message: `插件 ${plugin.name} 重复注册命令 ${name}，后一次被忽略`,
          }),
        );
        return;
      }
      if (!name.startsWith(`${plugin.name}.`)) {
        warnings.push(
          warning(plugin.name, "invalidName", {
            item: name,
            message: `插件 ${plugin.name} 的命令 ${name} 必须以插件名打头，该命令被忽略`,
          }),
        );
        return;
      }
      draftCommands.push([name, command]);
    },
  };

  try {
    plugin.extendSchema?.(schema);
    plugin.registerCommands?.(registry);
  } catch (error) {
    return { ok: false, error: toPluginError(plugin, error) };
  }

  return { ok: true, nodes: draftNodes, marks: draftMarks, commands: draftCommands, warnings };
}

function ownerOf(
  draft: Record<string, unknown>,
  name: string,
  plugin: EditorPlugin,
): string | undefined {
  return draft[name] ? plugin.name : undefined;
}

function describeOwner(owner: string | undefined): string {
  return !owner || owner === CORE ? "冻结核心集" : `插件 ${owner}`;
}

/** 携带结构化冲突信息的内部异常，只在暂存阶段流转。 */
class PluginConflict extends Error {
  constructor(
    readonly kind: PluginErrorKind,
    readonly item: string,
    readonly conflictWith: string,
    readonly what: string,
  ) {
    super(`${what} ${item} 与${describeOwner(conflictWith)}重名`);
  }
}

class InvalidPluginName extends Error {
  constructor(
    readonly item: string,
    readonly what: string,
  ) {
    super(`${what} ${item} 必须使用 co_ 命名空间`);
  }
}

function assertNamespace(plugin: EditorPlugin, name: string, what: string): void {
  if (!name.startsWith(plugin.namespace)) {
    throw new InvalidPluginName(name, what);
  }
}

function toPluginError(plugin: EditorPlugin, error: unknown): PluginError {
  if (error instanceof PluginConflict) {
    return fatal(plugin.name, error.kind, {
      item: error.item,
      conflictWith: error.conflictWith,
      message: `插件 ${plugin.name} 的${error.what} ${error.item} 与${describeOwner(error.conflictWith)}重名，该插件已禁用`,
    });
  }
  if (error instanceof InvalidPluginName) {
    return fatal(plugin.name, "invalidName", {
      item: error.item,
      message: `插件 ${plugin.name} 的${error.what} ${error.item} 必须使用 ${plugin.namespace} 命名空间，该插件已禁用`,
    });
  }
  return fatal(plugin.name, "runtimeError", {
    message: `插件 ${plugin.name} 启动时抛错：${describeError(error)}`,
  });
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fatal(
  plugin: string,
  kind: PluginErrorKind,
  rest: { item?: string; conflictWith?: string; message: string },
): PluginError {
  return { plugin, kind, disabled: true, tripped: true, ...rest };
}

function warning(
  plugin: string,
  kind: PluginErrorKind,
  rest: { item?: string; conflictWith?: string; message: string },
): PluginError {
  return { plugin, kind, disabled: false, tripped: false, ...rest };
}

/**
 * 依赖拓扑排序。成环的插件整环禁用，缺依赖的插件连同下游递归禁用，
 * 其余按依赖先后返回。
 */
function orderPlugins(
  plugins: EditorPlugin[],
  report: (error: PluginError) => void,
): EditorPlugin[] {
  const byName = new Map<string, EditorPlugin>();
  for (const plugin of plugins) {
    if (byName.has(plugin.name)) {
      report(
        fatal(plugin.name, "duplicatePlugin", {
          item: plugin.name,
          conflictWith: plugin.name,
          message: `插件名 ${plugin.name} 重复，后注册的实例已禁用`,
        }),
      );
      continue;
    }
    byName.set(plugin.name, plugin);
  }

  const status = new Map<string, "visiting" | "done" | "failed">();
  const stack: string[] = [];
  const ordered: EditorPlugin[] = [];

  const failPlugin = (
    name: string,
    kind: PluginErrorKind,
    rest: { item?: string; conflictWith?: string; message: string },
  ): void => {
    status.set(name, "failed");
    report(fatal(name, kind, rest));
  };

  const visit = (plugin: EditorPlugin): boolean => {
    const current = status.get(plugin.name);
    if (current === "done") {
      return true;
    }
    if (current === "failed") {
      return false;
    }
    if (current === "visiting") {
      const cycle = stack.slice(stack.indexOf(plugin.name));
      const trace = [...cycle, plugin.name].join(" → ");
      for (const name of cycle) {
        failPlugin(name, "cycle", { item: trace, message: `插件依赖成环并已全部禁用：${trace}` });
      }
      return false;
    }

    status.set(plugin.name, "visiting");
    stack.push(plugin.name);
    for (const dependency of plugin.dependsOn ?? []) {
      const required = byName.get(dependency);
      if (!required || !visit(required)) {
        // 环上的插件在上面已经报过一次，别重复上报。
        if (status.get(plugin.name) !== "failed") {
          failPlugin(plugin.name, "missingDependency", {
            item: dependency,
            conflictWith: dependency,
            message: required
              ? `插件 ${plugin.name} 的依赖 ${dependency} 不可用，已一并禁用`
              : `插件 ${plugin.name} 缺少依赖 ${dependency}，已禁用`,
          });
        }
        stack.pop();
        return false;
      }
    }
    stack.pop();
    if (status.get(plugin.name) === "failed") {
      return false;
    }
    status.set(plugin.name, "done");
    ordered.push(plugin);
    return true;
  };

  for (const plugin of byName.values()) {
    visit(plugin);
  }
  return ordered;
}
