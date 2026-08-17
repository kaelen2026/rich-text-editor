import type { Fragment, Node as ProseMirrorNode, Slice } from "prosemirror-model";
import type { Transaction } from "prosemirror-state";

/**
 * 文档节点数：`doc` 的全部后代，文本节点计一个。
 *
 * 这是一次全文遍历，因此不能每个事务都跑——调用方按 `insertedNodeCount`
 * 维护一个只增的保守上界，只有上界触到硬上限时才回来精确重算一次。
 */
export function countNodes(doc: ProseMirrorNode): number {
  let count = 0;
  doc.descendants(() => {
    count += 1;
    return true;
  });
  return count;
}

/**
 * 一个事务最多新增多少节点：各 step 携带的 slice 里的节点数之和。
 *
 * 刻意只算增量的上界而不算净变化——净变化要数被替换掉的那段旧内容，
 * 代价与被删范围成正比；而上界只与写入量成正比，打字是 O(1)。上界偏大
 * 的后果仅仅是提前触发一次精确重算，重算会把它收回到真实值。
 */
export function insertedNodeCount(transaction: Transaction): number {
  let count = 0;
  for (const step of transaction.steps) {
    // ReplaceStep / ReplaceAroundStep 带 slice，加标记与改属性的 step 不带。
    const slice = (step as Partial<{ slice: Slice }>).slice;
    if (slice) {
      count += countFragment(slice.content);
    }
  }
  return count;
}

function countFragment(fragment: Fragment): number {
  let count = 0;
  fragment.forEach((node) => {
    count += 1 + countFragment(node.content);
  });
  return count;
}
