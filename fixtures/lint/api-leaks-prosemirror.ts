import type { Node as ProseMirrorNode } from "prosemirror-model";

/**
 * 故意泄漏：业务接口不该出现 ProseMirror 的可变内部对象（方案 §7.1）。
 * `scripts/api-surface.mjs` 必须对它失败——这个 fixture 存在的意义就是证明
 * 那份检查真的会响，而不是一直在打印"通过"。
 */
export interface LeakyEditor {
  getInternalNode(): ProseMirrorNode;
}
