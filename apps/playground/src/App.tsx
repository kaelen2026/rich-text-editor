import { createEditor, type EditorOptions, type RichEditor } from "@kaelen/editor-api";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import {
  EditorContent,
  EditorProvider,
  useCommandQuery,
  useEditor,
  useEditorSelector,
  usePluginErrors,
} from "@kaelen/editor-react";
import { createEmptyEnvelope, stringifyEnvelope } from "@kaelen/editor-schema";
import type { EditorEnvelope } from "@kaelen/editor-shared-types";
import { useState } from "react";

const STORAGE_KEY = "playground.document";

type InstalledPlugins = NonNullable<EditorOptions["plugins"]>;

/**
 * 模拟一批坏掉的第三方插件。每一种坏法都必须只让它自己失效，
 * 编辑器照常可用、文档一字不丢（方案 §8.3、§8.6）。
 */
const FAULTY_PLUGINS: InstalledPlugins = [
  {
    // 运行期抛错：命令一调就炸，用来演示熔断。
    name: "fault",
    version: "0.0.1",
    namespace: "co_",
    registerCommands: (commands) =>
      commands.add("fault.crash", {
        run: () => {
          throw new Error("第三方插件内部错误");
        },
        active: () => false,
      }),
  },
  {
    // 想占用冻结核心集里的标记名。
    name: "shadow",
    version: "0.0.1",
    namespace: "co_",
    extendSchema: (schema) => schema.addMark("strong", { toDOM: () => ["b", 0] }),
  },
  {
    // 想覆盖核心命令：只有这条命令被忽略，插件其余能力保留。
    name: "hijack",
    version: "0.0.1",
    namespace: "co_",
    registerCommands: (commands) =>
      commands.add("format.bold", { run: () => ({ ok: true }), active: () => true }),
  },
  { name: "orphan", version: "0.0.1", namespace: "co_", dependsOn: ["never-installed"] },
  { name: "ring-a", version: "0.0.1", namespace: "co_", dependsOn: ["ring-b"] },
  { name: "ring-b", version: "0.0.1", namespace: "co_", dependsOn: ["ring-a"] },
];

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

interface Boot {
  editor: RichEditor;
  unknownNodes: string[];
  faulty: boolean;
}

function bootEditor(faulty: boolean, document: EditorEnvelope): Boot {
  const editor = createEditor({
    plugins: faulty ? [createLinkPlugin(), ...FAULTY_PLUGINS] : [createLinkPlugin()],
  });
  const result = editor.loadDocument(document);
  return { editor, unknownNodes: result.unknownNodes, faulty };
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

/** 降级提示。宿主只需要这一处：启动期冲突与运行期熔断都汇到这里。 */
function DegradedBanner() {
  const errors = usePluginErrors();
  if (errors.length === 0) {
    return null;
  }
  return (
    <div className="degraded" role="status">
      <strong>部分功能暂时不可用，内容已保留：</strong>
      <ul>
        {errors.map((error, index) => (
          <li key={`${error.plugin}-${error.kind}-${error.item ?? index}`}>{error.message}</li>
        ))}
      </ul>
    </div>
  );
}

function Toolbar({
  onSave,
  onLoadSample,
  faulty,
}: {
  onSave: () => void;
  onLoadSample: () => void;
  faulty: boolean;
}) {
  const editor = useEditor();
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
      {faulty ? (
        <button type="button" onClick={() => editor.execute("fault.crash")}>
          触发插件故障
        </button>
      ) : null}
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
  const [boot, setBoot] = useState<Boot>(() => bootEditor(false, readStoredDocument()));
  const [saved, setSaved] = useState<string | null>(null);
  const { editor, unknownNodes, faulty } = boot;

  function save() {
    const text = stringifyEnvelope(editor.getDocument());
    window.localStorage.setItem(STORAGE_KEY, text);
    setSaved(text);
    // markSaved 而不是 loadDocument：装载会重建状态并清空撤销历史。
    editor.markSaved();
  }

  function loadSample() {
    const result = editor.loadDocument(UNKNOWN_SAMPLE);
    setBoot({ ...boot, unknownNodes: result.unknownNodes });
    setSaved(null);
  }

  /** 装/不装故障插件是两种配置，切换即换一个实例；文档原样带过去。 */
  function toggleFault(next: boolean) {
    const document = editor.getDocument();
    editor.destroy();
    setBoot(bootEditor(next, document));
    setSaved(null);
  }

  return (
    <EditorProvider editor={editor}>
      <h1>富文本编辑器 · 插件冲突降级与熔断</h1>
      <p className="hint">
        输入文字，用 Cmd/Ctrl+B 加粗、Cmd/Ctrl+I 斜体、Cmd/Ctrl+Z 撤销；选中文本后可添加安全链接。
        点"保存"写入 localStorage，刷新页面内容仍在。
      </p>
      <label className="switch">
        <input
          type="checkbox"
          checked={faulty}
          onChange={(event) => toggleFault(event.target.checked)}
        />
        注入故障插件（重名、缺依赖、循环依赖、覆盖核心命令、命令抛错）
      </label>
      <DegradedBanner />
      {unknownNodes.length > 0 ? (
        <p className="warning">
          部分内容以只读形式显示，需要这些功能才能编辑：{unknownNodes.join("、")}
          。保存时这些内容会原样写回，不会丢失。
        </p>
      ) : null}
      <Toolbar onSave={save} onLoadSample={loadSample} faulty={faulty} />
      <div className="surface">
        <EditorContent />
      </div>
      {saved ? <pre>{saved}</pre> : null}
    </EditorProvider>
  );
}
