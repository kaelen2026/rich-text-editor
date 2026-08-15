/** 熔断窗口与阈值（方案 §8.6 第 3 条）。 */
export const BREAKER_WINDOW_MS = 60_000;
export const BREAKER_THRESHOLD = 3;

/**
 * 按插件计数的滑动窗口熔断器。
 *
 * 单次抛错不永久停用插件：一条坏输入不该让整个功能在本次会话里消失，
 * 所以每次失败都回滚到出错前的状态并再给它一次机会。反复出错才说明插件
 * 本身坏了——60 秒内 3 次即在本会话内停用，不再进入它的代码。
 */
export class PluginBreaker {
  private readonly failures = new Map<string, number[]>();
  private readonly tripped = new Set<string>();

  isTripped(plugin: string): boolean {
    return this.tripped.has(plugin);
  }

  /** 记录一次失败，返回本次是否触发熔断。 */
  record(plugin: string, at: number): boolean {
    const recent = (this.failures.get(plugin) ?? []).filter(
      (timestamp) => at - timestamp < BREAKER_WINDOW_MS,
    );
    recent.push(at);
    this.failures.set(plugin, recent);
    if (recent.length >= BREAKER_THRESHOLD) {
      this.tripped.add(plugin);
      return true;
    }
    return false;
  }
}
