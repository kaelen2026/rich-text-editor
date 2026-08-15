import type { CommandQuery, EditorSnapshot } from "@kaelen/editor-shared-types";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useEditor } from "./editor-context";

/**
 * 订阅编辑器状态。依赖 `getSnapshot()` 的引用稳定性：
 * 每次返回新对象会让 React 抛 `The result of getSnapshot should be cached`。
 */
export function useEditorSnapshot(): EditorSnapshot {
  const editor = useEditor();
  const subscribe = useCallback(
    (onStoreChange: () => void) => editor.subscribe("change", onStoreChange),
    [editor],
  );
  const getSnapshot = useCallback(() => editor.getSnapshot(), [editor]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * 只订阅所需的那一部分状态，避免每次事务都重渲染整棵页面（方案 §10.2）。
 * selector 需为纯函数：派生值按快照引用缓存。
 */
export function useEditorSelector<TSelected>(
  selector: (snapshot: EditorSnapshot) => TSelected,
): TSelected {
  const editor = useEditor();
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const cacheRef = useRef<{ snapshot: EditorSnapshot; selected: TSelected } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => editor.subscribe("change", onStoreChange),
    [editor],
  );

  const getSelected = useCallback(() => {
    const snapshot = editor.getSnapshot();
    const cached = cacheRef.current;
    if (cached && cached.snapshot === snapshot) {
      return cached.selected;
    }
    const selected = selectorRef.current(snapshot);
    cacheRef.current = { snapshot, selected };
    return selected;
  }, [editor]);

  return useSyncExternalStore(subscribe, getSelected, getSelected);
}

/**
 * 工具栏按钮所需的状态。不读文档，只查命令。
 * 带参数的命令（如 `block.setHeading` 的层级）把参数一并传进来。
 */
export function useCommandQuery(command: string, input?: unknown): CommandQuery {
  const editor = useEditor();
  useEditorSnapshot();
  return editor.queryCommand(command, input);
}
