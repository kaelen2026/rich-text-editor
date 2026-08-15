import { coreMarks, coreNodes } from "@kaelen/editor-schema";
import type { CoreMarkSpec, CoreNodeSpec, DomOutputSpec } from "@kaelen/editor-shared-types";
import {
  type DOMOutputSpec,
  type MarkSpec,
  type NodeSpec,
  type Mark as ProseMirrorMark,
  type Node as ProseMirrorNode,
  Schema,
} from "prosemirror-model";

/**
 * 把平台自有的 Spec 装配为 ProseMirror Schema。
 *
 * 平台 Spec 的 `toDOM` 只能返回纯数据（`DomOutputSpec`），因此这里是唯一
 * 需要与 ProseMirror 打交道的地方；`editor-schema` 自身对 ProseMirror 与 DOM
 * 都零依赖（方案 §7.1）。
 */
export interface SchemaExtensions {
  nodes?: Record<string, CoreNodeSpec>;
  marks?: Record<string, CoreMarkSpec>;
}

export function buildSchema(extensions: SchemaExtensions = {}): Schema {
  return new Schema({
    nodes: mapSpecs({ ...coreNodes, ...extensions.nodes }, toNodeSpec),
    marks: mapSpecs({ ...coreMarks, ...extensions.marks }, toMarkSpec),
  });
}

function mapSpecs<TIn, TOut>(
  specs: Record<string, TIn>,
  map: (spec: TIn) => TOut,
): Record<string, TOut> {
  const mapped: Record<string, TOut> = {};
  for (const [name, spec] of Object.entries(specs)) {
    mapped[name] = map(spec);
  }
  return mapped;
}

/**
 * 渲染函数只收到 `{ attrs }`，拿不到 ProseMirror 节点。这个包装是"`toDOM`
 * 不得访问 `document` 或文档内部"这条约束的结构性保障，不只是约定。
 */
function toNodeSpec(spec: CoreNodeSpec): NodeSpec {
  const { toDOM, ...rest } = spec;
  if (!toDOM) {
    return rest;
  }
  return {
    ...rest,
    toDOM: (node: ProseMirrorNode) => asDomOutputSpec(toDOM({ attrs: node.attrs })),
  };
}

function toMarkSpec(spec: CoreMarkSpec): MarkSpec {
  const { toDOM, ...rest } = spec;
  if (!toDOM) {
    return rest;
  }
  return {
    ...rest,
    toDOM: (mark: ProseMirrorMark) => asDomOutputSpec(toDOM({ attrs: mark.attrs })),
  };
}

function asDomOutputSpec(spec: DomOutputSpec): DOMOutputSpec {
  return spec as DOMOutputSpec;
}
