import type {
  DocumentPatch,
  MarkJSON,
  NodeJSON,
  PatchOp,
  SliceJSON,
} from "@kaelen/editor-shared-types";
import { Fragment, Mark, Node as ProseMirrorNode, type Schema, Slice } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";
import {
  AddMarkStep,
  AttrStep,
  RemoveMarkStep,
  ReplaceStep,
  type Step,
  Transform,
} from "prosemirror-transform";

export type PatchApplyResult =
  | { ok: true; document: NodeJSON; revision: number }
  | { ok: false; reason: "revision-mismatch"; expectedRevision: number }
  | { ok: false; reason: "invalid-patch"; detail: string };

/** 把 PM 的一步转换成平台 PatchOp；复杂结构步骤由事务转换器回退为整篇 replace。 */
export function stepToPatchOp(step: Step): PatchOp | null {
  if (step instanceof ReplaceStep) {
    return { type: "replace", from: step.from, to: step.to, slice: sliceToJSON(step.slice) };
  }
  if (step instanceof AddMarkStep || step instanceof RemoveMarkStep) {
    return {
      type: "mark",
      from: step.from,
      to: step.to,
      mark: step.mark.toJSON() as MarkJSON,
      add: step instanceof AddMarkStep,
    };
  }
  if (step instanceof AttrStep) {
    return { type: "attr", pos: step.pos, attrs: { [step.attr]: step.value } };
  }
  return null;
}

/** 把一个平台操作还原成 PM Step；属性操作可能展开成多个 AttrStep。 */
export function patchOpToSteps(schema: Schema, document: ProseMirrorNode, op: PatchOp): Step[] {
  switch (op.type) {
    case "replace":
      return [new ReplaceStep(op.from, op.to, sliceFromJSON(schema, op.slice))];
    case "mark": {
      const mark = Mark.fromJSON(schema, op.mark);
      const StepType = op.add ? AddMarkStep : RemoveMarkStep;
      return [new StepType(op.from, op.to, mark)];
    }
    case "attr": {
      const node = document.nodeAt(op.pos);
      if (!node) {
        throw new Error(`属性操作的位置 ${op.pos} 没有节点`);
      }
      return Object.entries(op.attrs).map(([attr, value]) => new AttrStep(op.pos, attr, value));
    }
  }
}

/**
 * 从事务构造带逆操作的 patch。不能无损表示的结构步骤收敛为一条整篇 replace，
 * 以保证所有 PM 事务仍可安全重放，而不是静默漏掉内容变更。
 */
export function documentPatchFromTransaction(
  transaction: Transaction,
  from: number,
  to: number,
): DocumentPatch {
  const ops = transaction.steps.map(stepToPatchOp);
  const inverseSteps: Step[] = [];
  for (let index = transaction.steps.length - 1; index >= 0; index -= 1) {
    const step = transaction.steps[index];
    const document = transaction.docs[index];
    if (!step || !document) {
      throw new Error("文档事务的步骤与起始文档不匹配");
    }
    inverseSteps.push(step.invert(document));
  }
  const inverse = inverseSteps.map(stepToPatchOp);
  if (ops.some((op) => op === null) || inverse.some((op) => op === null)) {
    const before = transaction.docs[0];
    if (!before) {
      throw new Error("文档事务没有起始文档");
    }
    return wholeDocumentPatch(before, transaction.doc, from, to);
  }
  return { v: 1, from, to, ops: ops as PatchOp[], inverse: inverse as PatchOp[] };
}

/**
 * 应用 patch 前先校验 revision。服务端可以使用同一逻辑拒绝过期写入，客户端据此
 * 重放缺失 patch 后再提交。
 */
export function applyDocumentPatch(
  schema: Schema,
  document: NodeJSON,
  patch: DocumentPatch,
  currentRevision: number,
): PatchApplyResult {
  if (patch.v !== 1 || patch.from !== currentRevision) {
    return { ok: false, reason: "revision-mismatch", expectedRevision: currentRevision };
  }
  let transform: Transform;
  try {
    transform = new Transform(ProseMirrorNode.fromJSON(schema, document));
    for (const op of patch.ops) {
      for (const step of patchOpToSteps(schema, transform.doc, op)) {
        const result = transform.maybeStep(step);
        if (result.failed) {
          return { ok: false, reason: "invalid-patch", detail: result.failed };
        }
      }
    }
  } catch (error) {
    return {
      ok: false,
      reason: "invalid-patch",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  return { ok: true, document: transform.doc.toJSON() as NodeJSON, revision: patch.to };
}

function wholeDocumentPatch(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  from: number,
  to: number,
): DocumentPatch {
  return {
    v: 1,
    from,
    to,
    ops: [{ type: "replace", from: 0, to: before.content.size, slice: contentSlice(after) }],
    inverse: [{ type: "replace", from: 0, to: after.content.size, slice: contentSlice(before) }],
  };
}

function contentSlice(document: ProseMirrorNode): SliceJSON {
  return sliceToJSON(new Slice(document.content, 0, 0));
}

function sliceToJSON(slice: Slice): SliceJSON {
  const json = slice.toJSON() as { content?: NodeJSON[]; openStart?: number; openEnd?: number };
  return {
    content: json.content ?? [],
    openStart: json.openStart ?? 0,
    openEnd: json.openEnd ?? 0,
  };
}

function sliceFromJSON(schema: Schema, slice: SliceJSON): Slice {
  return new Slice(Fragment.fromJSON(schema, slice.content), slice.openStart, slice.openEnd);
}
