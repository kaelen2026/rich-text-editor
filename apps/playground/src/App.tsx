import { createEditor, type RichEditor } from "@kaelen/editor-api";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
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

/** 模拟一份由"已安装表格与提及插件"的环境写出的文档。 */
const UNKNOWN_SAMPLE: EditorEnvelope = {
  envelope: 1,
  schemaVersion: 1,
  plugins: { table: 2, mention: 1 },
  doc: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "下面是本环境没有装插件的内容：" }] },
      {
        type: "co_table",
        attrs: { cols: 2 },
        content: [
          {
            type: "co_table_row",
            content: [
              {
                type: "co_table_cell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "单元格" }] }],
              },
            ],
          },
        ],
      },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "行内也可以：" },
          { type: "co_mention", attrs: { userId: "u_1" } },
          { type: "text", text: "，占位是只读的。" },
        ],
      },
    ],
  },
  annotations: [],
};

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

function Toolbar({ onSave, onLoadSample }: { onSave: () => void; onLoadSample: () => void }) {
  const dirty = useEditorSelector((snapshot) => snapshot.dirty);
  const revision = useEditorSelector((snapshot) => snapshot.revision);

  return (
    <div className="toolbar">
      <CommandButton command="format.bold" label="B" />
      <CommandButton command="format.italic" label="I" />
      <CommandButton command="history.undo" label="撤销" />
      <CommandButton command="history.redo" label="重做" />
      <LinkButton />
      <CommandButton command="link.unset" label="取消链接" />
      <button type="button" onClick={onSave}>
        保存
      </button>
      <button type="button" onClick={onLoadSample}>
        装载含未知节点的示例
      </button>
      <span className="status">
        修订号 {revision} · {dirty ? "未保存" : "已保存"}
      </span>
    </div>
  );
}

function LinkButton() {
  const editor = useEditor();
  const { enabled, active } = useCommandQuery("link.set");

  return (
    <button
      type="button"
      data-active={active}
      disabled={!enabled}
      onMouseDown={(event) => {
        event.preventDefault();
        const href = window.prompt("链接地址（仅 https/http/mailto/tel）", "https://");
        if (href) {
          editor.execute("link.set", { href });
        }
      }}
    >
      链接
    </button>
  );
}

export function App() {
  const bootRef = useRef<{ editor: RichEditor; unknownNodes: string[] } | null>(null);
  if (!bootRef.current) {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    const result = editor.loadDocument(readStoredDocument());
    bootRef.current = { editor, unknownNodes: result.unknownNodes };
  }
  const { editor } = bootRef.current;
  const [unknownNodes, setUnknownNodes] = useState<string[]>(bootRef.current.unknownNodes);
  const [saved, setSaved] = useState<string | null>(null);

  function save() {
    const text = stringifyEnvelope(editor.getDocument());
    window.localStorage.setItem(STORAGE_KEY, text);
    setSaved(text);
    // markSaved 而不是 loadDocument：装载会重建状态并清空撤销历史。
    editor.markSaved();
  }

  function loadSample() {
    const result = editor.loadDocument(UNKNOWN_SAMPLE);
    setUnknownNodes(result.unknownNodes);
    setSaved(null);
  }

  return (
    <EditorProvider editor={editor}>
      <h1>富文本编辑器 · 插件运行时与链接</h1>
      <p className="hint">
        输入文字，用 Cmd/Ctrl+B 加粗、Cmd/Ctrl+I 斜体、Cmd/Ctrl+Z 撤销；选中文本后可添加安全链接。
        点"保存"写入 localStorage，刷新页面内容仍在。
      </p>
      {unknownNodes.length > 0 ? (
        <p className="warning">
          部分内容以只读形式显示，需要这些功能才能编辑：{unknownNodes.join("、")}
          。保存时这些内容会原样写回，不会丢失。
        </p>
      ) : null}
      <Toolbar onSave={save} onLoadSample={loadSample} />
      <div className="surface">
        <EditorContent />
      </div>
      {saved ? <pre>{saved}</pre> : null}
    </EditorProvider>
  );
}
