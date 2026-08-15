/**
 * 文档 JSON 的深拷贝。
 *
 * 文档在信封与编辑器之间来回传递时必须是快照而不是引用：调用方改写自己传入的
 * 对象、或改写取回的结果，都不得影响另一侧（方案 §9.3）。
 *
 * `structuredClone` 遇到函数等不可克隆值会抛 `DataCloneError`，因此退回 JSON
 * 轮转——文档本来就只由 JSON 值构成，轮转会把非法值丢掉而不是让装载失败。
 */
export function cloneJson<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
