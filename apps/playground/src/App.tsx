import { createEditor, type EditorOptions, type RichEditor } from "@kaelen/editor-api";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { applyDocumentPatch, buildSchema } from "@kaelen/editor-pm-adapter";
import {
  EditorContent,
  EditorProvider,
  useCommandQuery,
  useEditor,
  useEditorSelector,
  usePluginErrors,
} from "@kaelen/editor-react";
import { createEmptyEnvelope, stringifyEnvelope } from "@kaelen/editor-schema";
import type { DocumentPatch, EditorEnvelope, EditorMode } from "@kaelen/editor-shared-types";
import { useEffect, useState } from "react";

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
  baseDocument: EditorEnvelope;
}

function bootEditor(faulty: boolean, document: EditorEnvelope): Boot {
  const editor = createEditor({
    plugins: faulty ? [createLinkPlugin(), ...FAULTY_PLUGINS] : [createLinkPlugin()],
  });
  const result = editor.loadDocument(document);
  return { editor, unknownNodes: result.unknownNodes, faulty, baseDocument: document };
}

function CommandButton({
  command,
  label,
  input,
  title,
}: {
  command: string;
  label: string;
  input?: unknown;
  title?: string;
}) {
  const editor = useEditor();
  const { enabled, active } = useCommandQuery(command, input);
  return (
    <button
      type="button"
      title={title}
      data-active={active}
      disabled={!enabled}
      onMouseDown={(event) => {
        // 保住选区：按下时不让焦点离开编辑区。
        event.preventDefault();
        editor.execute(command, input);
      }}
    >
      {label}
    </button>
  );
}

function ModeSwitch() {
  const editor = useEditor();
  const mode = useEditorSelector((snapshot) => snapshot.mode);
  return (
    <label className="mode">
      状态
      <select value={mode} onChange={(event) => editor.setMode(event.target.value as EditorMode)}>
        <option value="edit">编辑</option>
        <option value="readonly">只读（可选中可复制）</option>
        <option value="disabled">禁用（不可聚焦）</option>
      </select>
    </label>
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
    <>
      <div className="toolbar">
        <CommandButton command="block.setParagraph" label="正文" title="Cmd/Ctrl+Alt+0" />
        {[1, 2, 3, 4].map((level) => (
          <CommandButton
            key={level}
            command="block.setHeading"
            input={{ level }}
            label={`H${level}`}
            title={`Cmd/Ctrl+Alt+${level}`}
          />
        ))}
        <CommandButton command="block.toggleBlockquote" label="引用" title="Cmd/Ctrl+Shift+>" />
        <CommandButton command="block.toggleCodeBlock" label="代码块" title="Cmd/Ctrl+Alt+C" />
        <CommandButton command="block.insertHorizontalRule" label="分隔线" title="Cmd/Ctrl+Alt+R" />
      </div>
      <div className="toolbar">
        <CommandButton command="list.toggleBullet" label="• 列表" title="Cmd/Ctrl+Shift+8" />
        <CommandButton command="list.toggleOrdered" label="1. 列表" title="Cmd/Ctrl+Shift+9" />
        <CommandButton command="list.toggleTask" label="☐ 待办" title="Cmd/Ctrl+Shift+7" />
        <CommandButton command="list.toggleChecked" label="勾选" />
        <CommandButton command="list.indent" label="缩进" title="Tab" />
        <CommandButton command="list.outdent" label="提升" title="Shift+Tab" />
      </div>
      <div className="toolbar">
        <CommandButton command="format.bold" label="B" title="Cmd/Ctrl+B" />
        <CommandButton command="format.italic" label="I" title="Cmd/Ctrl+I" />
        <CommandButton command="format.underline" label="U" title="Cmd/Ctrl+U" />
        <CommandButton command="format.strikethrough" label="S" title="Cmd/Ctrl+Shift+X" />
        <CommandButton command="format.code" label="<>" title="Cmd/Ctrl+E" />
        <LinkButton />
        <CommandButton command="link.unset" label="取消链接" />
        <CommandButton command="history.undo" label="撤销" title="Cmd/Ctrl+Z" />
        <CommandButton command="history.redo" label="重做" title="Cmd/Ctrl+Shift+Z" />
      </div>
      <div className="toolbar">
        <ModeSwitch />
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
    </>
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

/** 只消费 patch 事件：面板不调用 getDocument()，避免每次变更都全文序列化。 */
function PatchPanel({ baseDocument }: { baseDocument: EditorEnvelope }) {
  const editor = useEditor();
  const [patches, setPatches] = useState<DocumentPatch[]>([]);
  const [replay, setReplay] = useState<string | null>(null);

  useEffect(() => {
    setPatches([]);
    setReplay(null);
    return editor.subscribe("patch", (patch) => setPatches((current) => [...current, patch]));
  }, [editor]);

  function replayAll() {
    let document = baseDocument.doc;
    let revision = 0;
    for (const patch of patches) {
      const result = applyDocumentPatch(buildSchema(), document, patch, revision);
      if (!result.ok) {
        setReplay(`重放失败：${result.reason}`);
        return;
      }
      document = result.document;
      revision = result.revision;
    }
    setReplay(
      JSON.stringify({
        ok: JSON.stringify(document) === JSON.stringify(editor.getDocument().doc),
        revision,
        document,
      }),
    );
  }

  return (
    <section className="patch-panel">
      <div className="patch-heading">
        <strong>DocumentPatch 增量流</strong>
        <button type="button" onClick={replayAll} disabled={patches.length === 0}>
          从初始文档重放全部 patch
        </button>
      </div>
      <p>
        {patches.length === 0
          ? "编辑后会显示增量，不会输出全文。"
          : `已捕获 ${patches.length} 条 patch。`}
      </p>
      {patches.length > 0 ? <pre>{JSON.stringify(patches, null, 2)}</pre> : null}
      {replay ? <pre>{replay}</pre> : null}
    </section>
  );
}

export function App() {
  const [boot, setBoot] = useState<Boot>(() => bootEditor(false, readStoredDocument()));
  const [saved, setSaved] = useState<string | null>(null);
  const { editor, unknownNodes, faulty, baseDocument } = boot;

  function save() {
    const text = stringifyEnvelope(editor.getDocument());
    window.localStorage.setItem(STORAGE_KEY, text);
    setSaved(text);
    // markSaved 而不是 loadDocument：装载会重建状态并清空撤销历史。
    editor.markSaved();
  }

  function loadSample() {
    const result = editor.loadDocument(UNKNOWN_SAMPLE);
    setBoot({ ...boot, unknownNodes: result.unknownNodes, baseDocument: UNKNOWN_SAMPLE });
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
      <h1>富文本编辑器 · 块级结构、内部复制粘贴与插件熔断</h1>
      <p className="hint">
        {
          "标题、引用、列表、待办、代码块、分隔线都在工具栏上，按钮的 tooltip 是对应快捷键；列表里 Tab / Shift+Tab 升降级，Shift+Enter 软换行。复制会把可还原的 Slice 写入 HTML 的 data-co-slice，粘贴时优先恢复它；Cmd/Ctrl+Shift+V 与代码块内粘贴始终只取纯文本。切换状态可以看只读态与禁用态的区别；点保存写入 localStorage，刷新页面内容仍在。"
        }
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
      <PatchPanel baseDocument={baseDocument} />
      {saved ? <pre>{saved}</pre> : null}
    </EditorProvider>
  );
}
