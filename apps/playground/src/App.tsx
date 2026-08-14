import { createEditor, type RichEditor } from "@kaelen/editor-api";
import {
  EditorContent,
  EditorProvider,
  useCommandQuery,
  useEditor,
  useEditorSelector,
} from "@kaelen/editor-react";
import { createEmptyEnvelope, stringifyEnvelope } from "@kaelen/editor-schema";
import type { EditorEnvelope } from "@kaelen/editor-shared-types";
import { useRef, useState } from "react";

const STORAGE_KEY = "playground.document";

function readStoredDocument(): EditorEnvelope {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return createEmptyEnvelope();
  }
  try {
    return JSON.parse(raw) as EditorEnvelope;
  } catch {
    return createEmptyEnvelope();
  }
}

function CommandButton({ command, label }: { command: string; label: string }) {
  const editor = useEditor();
  const { enabled, active } = useCommandQuery(command);
  return (
    <button
      type="button"
      data-active={active}
      disabled={!enabled}
      onMouseDown={(event) => {
        // 保住选区：按下时不让焦点离开编辑区。
        event.preventDefault();
        editor.execute(command);
      }}
    >
      {label}
    </button>
  );
}

function Toolbar({ onSave }: { onSave: () => void }) {
  const dirty = useEditorSelector((snapshot) => snapshot.dirty);
  const revision = useEditorSelector((snapshot) => snapshot.revision);

  return (
    <div className="toolbar">
      <CommandButton command="format.bold" label="B" />
      <CommandButton command="format.italic" label="I" />
      <CommandButton command="history.undo" label="撤销" />
      <CommandButton command="history.redo" label="重做" />
      <button type="button" onClick={onSave}>
        保存
      </button>
      <span className="status">
        修订号 {revision} · {dirty ? "未保存" : "已保存"}
      </span>
    </div>
  );
}

export function App() {
  const editorRef = useRef<RichEditor | null>(null);
  if (!editorRef.current) {
    const editor = createEditor();
    editor.loadDocument(readStoredDocument());
    editorRef.current = editor;
  }
  const editor = editorRef.current;
  const [saved, setSaved] = useState<string | null>(null);

  function save() {
    const text = stringifyEnvelope(editor.getDocument());
    window.localStorage.setItem(STORAGE_KEY, text);
    setSaved(text);
    // markSaved 而不是 loadDocument：装载会重建状态并清空撤销历史。
    editor.markSaved();
  }

  return (
    <EditorProvider editor={editor}>
      <h1>富文本编辑器 · S1 最小可编辑闭环</h1>
      <p className="hint">
        输入文字，用 Cmd/Ctrl+B 加粗、Cmd/Ctrl+I 斜体、Cmd/Ctrl+Z 撤销；点"保存"写入
        localStorage，刷新页面内容仍在。
      </p>
      <Toolbar onSave={save} />
      <div className="surface">
        <EditorContent />
      </div>
      {saved ? <pre>{saved}</pre> : null}
    </EditorProvider>
  );
}
