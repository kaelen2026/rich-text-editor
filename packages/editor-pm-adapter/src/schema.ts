import { coreMarks, coreNodes } from "@kaelen/editor-schema";
import type { CoreMarkSpec, CoreNodeSpec } from "@kaelen/editor-shared-types";
import { type MarkSpec, type NodeSpec, Schema } from "prosemirror-model";

/**
 * 把平台自有的 Spec 装配为 ProseMirror Schema。
 *
 * 平台 Spec 的 `toDOM` 只能返回纯数据（`DomOutputSpec`），因此这里是唯一
 * 需要与 ProseMirror 打交道的地方；`editor-schema` 自身对 ProseMirror 与 DOM
 * 都零依赖（方案 §7.1）。
 */
export function buildSchema(): Schema {
  return new Schema({
    nodes: mapSpecs<CoreNodeSpec, NodeSpec>(coreNodes),
    marks: mapSpecs<CoreMarkSpec, MarkSpec>(coreMarks),
  });
}

function mapSpecs<TIn, TOut>(specs: Record<string, TIn>): Record<string, TOut> {
  const mapped: Record<string, TOut> = {};
  for (const [name, spec] of Object.entries(specs)) {
    mapped[name] = spec as unknown as TOut;
  }
  return mapped;
}
