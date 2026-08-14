import type { RichEditor } from "@kaelen/editor-api";
import { createContext, type ReactNode, useContext } from "react";

const EditorContext = createContext<RichEditor | null>(null);

export interface EditorProviderProps {
  editor: RichEditor;
  children: ReactNode;
}

/**
 * 注入同一个编辑器实例。实例由业务创建（框架无关），生命周期由创建者负责；
 * 适配层只负责挂载与订阅（方案 §10.1）。
 */
export function EditorProvider({ editor, children }: EditorProviderProps) {
  return <EditorContext.Provider value={editor}>{children}</EditorContext.Provider>;
}

export function useEditor(): RichEditor {
  const editor = useContext(EditorContext);
  if (!editor) {
    throw new Error("useEditor 必须在 EditorProvider 内部使用");
  }
  return editor;
}
