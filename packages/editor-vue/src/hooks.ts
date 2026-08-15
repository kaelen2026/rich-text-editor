import type { CommandQuery, EditorSnapshot, PluginError } from "@kaelen/editor-shared-types";
import {
  type ComputedRef,
  computed,
  onScopeDispose,
  readonly,
  type ShallowRef,
  shallowRef,
} from "vue";
import { useEditor } from "./editor-context";

/** Reactive editor snapshot with the same stable-reference contract used by React. */
export function useEditorSnapshot(): Readonly<ShallowRef<EditorSnapshot>> {
  const editor = useEditor();
  const snapshot = shallowRef(editor.getSnapshot());
  onScopeDispose(editor.subscribe("change", () => (snapshot.value = editor.getSnapshot())));
  return readonly(snapshot);
}

export function useEditorSelector<TSelected>(
  selector: (snapshot: EditorSnapshot) => TSelected,
): ComputedRef<TSelected> {
  const snapshot = useEditorSnapshot();
  return computed(() => selector(snapshot.value));
}

export function usePluginErrors(): Readonly<ShallowRef<readonly PluginError[]>> {
  const editor = useEditor();
  const errors = shallowRef(editor.getPluginErrors());
  onScopeDispose(editor.subscribe("pluginError", () => (errors.value = editor.getPluginErrors())));
  return readonly(errors);
}

export function useCommandQuery(command: string, input?: unknown): ComputedRef<CommandQuery> {
  const editor = useEditor();
  const snapshot = useEditorSnapshot();
  return computed(() => {
    snapshot.value;
    return editor.queryCommand(command, input);
  });
}
