// @vitest-environment jsdom
import { createEditor } from "@kaelen/editor-api";
import { afterEach, describe, expect, it, vi } from "vitest";

function startComposition(editor: ReturnType<typeof createEditor>, host: HTMLElement): void {
  editor.mount(host);
  host
    .querySelector<HTMLElement>("[contenteditable=true]")
    ?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("组合态公开契约", () => {
  it("通过快照和 compositionChanged 事件公开组合态，execute 返回 composing", () => {
    const editor = createEditor();
    const host = document.createElement("div");
    const changes: boolean[] = [];
    editor.subscribe("compositionChanged", (composing) => changes.push(composing));

    startComposition(editor, host);

    expect(editor.getSnapshot().composing).toBe(true);
    expect(editor.getSelectionState().composing).toBe(true);
    expect(changes).toEqual([true]);
    expect(editor.execute("format.bold")).toEqual({ ok: false, reason: "composing" });

    host
      .querySelector<HTMLElement>("[contenteditable=true]")
      ?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    expect(changes).toEqual([true, false]);
  });

  it("五秒兜底会把公开组合态恢复为 false", () => {
    vi.useFakeTimers();
    const editor = createEditor();
    const host = document.createElement("div");
    startComposition(editor, host);

    vi.advanceTimersByTime(5_000);

    expect(editor.getSnapshot().composing).toBe(false);
  });
});
