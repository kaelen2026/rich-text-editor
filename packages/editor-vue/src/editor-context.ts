import type { RichEditor } from "@kaelen/editor-api";
import { type InjectionKey, inject, provide } from "vue";

export const editorKey: InjectionKey<RichEditor> = Symbol("kaelen-rich-editor");

export function provideEditor(editor: RichEditor): void {
  provide(editorKey, editor);
}

export function useEditor(): RichEditor {
  const editor = inject(editorKey);
  if (!editor) {
    throw new Error("useEditor 必须在 EditorProvider 内部使用");
  }
  return editor;
}
