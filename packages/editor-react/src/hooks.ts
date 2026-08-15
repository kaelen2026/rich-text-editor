import type { CommandQuery, EditorSnapshot, PluginError } from "@kaelen/editor-shared-types";
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
 * 插件降级记录，供宿主展示"X 功能暂时不可用，内容已保留"（方案 §8.6）。
 * 初值取自 `getPluginErrors()` 而不是空数组：启动期的冲突发生在订阅之前。
 */
export function usePluginErrors(): readonly PluginError[] {
  const editor = useEditor();
  const subscribe = useCallback(
    (onStoreChange: () => void) => editor.subscribe("pluginError", onStoreChange),
    [editor],
  );
  const getSnapshot = useCallback(() => editor.getPluginErrors(), [editor]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 工具栏按钮所需的状态。不读文档，只查命令。 */
export function useCommandQuery(command: string): CommandQuery {
  const editor = useEditor();
  useEditorSnapshot();
  return editor.queryCommand(command);
}
