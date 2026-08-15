import type { DocumentPatch } from "@kaelen/editor-shared-types";

export interface AutoSaveContext {
  patches: readonly DocumentPatch[];
  revision: number;
}

export interface AutoSaveOptions {
  /** 连续编辑停止后多久提交，默认 2 秒。 */
  delayMs?: number;
  /** 不等空闲、直接提交的累计变更数，默认 50。 */
  maxChanges?: number;
  onSave(context: AutoSaveContext): void | Promise<void>;
}

/**
 * 纯调度器：聚合连续 patch，不序列化整篇文档。保存成功后的状态更新由 runtime
 * 注入，这样较晚返回的旧请求不会错误清除新的脏标记。
 */
export class AutoSaveScheduler {
  private readonly delayMs: number;
  private readonly maxChanges: number;
  private pending: DocumentPatch[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: AutoSaveOptions,
    private readonly onSaved: (revision: number) => void,
  ) {
    this.delayMs = options.delayMs ?? 2_000;
    this.maxChanges = options.maxChanges ?? 50;
  }

  add(patch: DocumentPatch): void {
    this.pending.push(patch);
    if (this.pending.length >= this.maxChanges) {
      this.flush();
      return;
    }
    this.resetTimer();
  }

  destroy(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending = [];
  }

  private resetTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => this.flush(), this.delayMs);
  }

  private flush(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) {
      return;
    }
    const patches = this.pending;
    this.pending = [];
    const lastPatch = patches.at(-1);
    if (!lastPatch) {
      return;
    }
    const revision = lastPatch.to;
    try {
      const result = this.options.onSave({ patches, revision });
      void Promise.resolve(result).then(
        () => this.onSaved(revision),
        // 保存失败时保留脏标记，下一次编辑会再触发一次保存。
        () => {},
      );
    } catch {
      // 同步保存器也遵循同一语义：失败不清除脏标记。
    }
  }
}
