import { createEditor, type EditorOptions, type RichEditor } from "@kaelen/editor-api";
import { markdownToDocument } from "@kaelen/editor-markdown";
import { createColorPlugin } from "@kaelen/editor-plugin-color";
import { createImagePlugin } from "@kaelen/editor-plugin-image";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { createTablePlugin } from "@kaelen/editor-plugin-table";
import { applyDocumentPatch, buildSchema } from "@kaelen/editor-pm-adapter";
import {
  EditorContent,
  EditorProvider,
  useEditor,
  useEditorSelector,
  usePluginErrors,
} from "@kaelen/editor-react";
import { EditorToolbar } from "@kaelen/editor-react-ui";
import { createEmptyEnvelope, stringifyEnvelope } from "@kaelen/editor-schema";
import {
  DOCUMENT_JSON_LIMIT_BYTES,
  type DocumentPatch,
  type EditorEnvelope,
  type EditorMode,
} from "@kaelen/editor-shared-types";
import type { ToolbarDefinition } from "@kaelen/editor-ui-model";
import {
  Baseline,
  Bold,
  Braces,
  ChevronDown,
  ChevronRight,
  Code,
  CodeXml,
  Columns3,
  FlaskConical,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Image,
  Italic,
  Link,
  List,
  ListChecks,
  ListIndentDecrease,
  ListIndentIncrease,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  Merge,
  Minus,
  PaintBucket,
  Pilcrow,
  Redo2,
  Rows3,
  Save,
  Split,
  SquareCheckBig,
  Strikethrough,
  Table,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  TextQuote,
  Trash2,
  Type,
  Underline,
  Undo2,
  Unlink,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { ColorPicker, type ColorPickerMenu } from "./color-picker";
import { ImageToolbar } from "./image-toolbar";

const STORAGE_KEY = "playground.document";

/** 仅用于 playground 的可取消上传模拟器；生产宿主传入自己的对象存储适配器。 */
const playgroundUploader = {
  async upload(file: File, { signal }: { uploadId: string; signal: AbortSignal }) {
    await simulateLatency(900, signal);
    // 原始像素尺寸由上传服务给出：裁剪与旋转靠它推导展示盒，缺了就用不了。
    return { url: URL.createObjectURL(file), alt: file.name, ...(await measure(file)) };
  },
};

function simulateLatency(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        window.clearTimeout(timer);
        reject(new DOMException("上传已取消", "AbortError"));
      },
      { once: true },
    );
  });
}

async function measure(file: File): Promise<{ width?: number; height?: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    // 解不出尺寸也照样上传：图片能显示，只是裁剪与旋转会被禁用。
    return {};
  }
}

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

/**
 * 菜单里的条目。它们不进 ToolbarDefinition：模型只管可见按钮的漫游焦点，
 * 菜单内容由宿主用 renderMenu 画，每条自己查命令状态。
 */
interface MenuEntry {
  id: string;
  label: string;
  command: string;
  input?: unknown;
  shortcut?: string;
}

const TOOLBAR_MENUS: Record<string, readonly MenuEntry[]> = {
  "block-style": [
    { id: "paragraph", label: "正文", command: "block.setParagraph", shortcut: "Mod-Alt-0" },
    ...[1, 2, 3, 4].map((level) => ({
      id: `heading-${level}`,
      label: `${level} 级标题`,
      command: "block.setHeading",
      input: { level },
      shortcut: `Mod-Alt-${level}`,
    })),
    { id: "quote", label: "引用", command: "block.toggleBlockquote", shortcut: "Mod-Shift->" },
    { id: "code-block", label: "代码块", command: "block.toggleCodeBlock", shortcut: "Mod-Alt-C" },
    { id: "rule", label: "分隔线", command: "block.insertHorizontalRule", shortcut: "Mod-Alt-R" },
  ],
  align: [
    {
      id: "align-left",
      label: "左对齐",
      command: "block.setAlign",
      input: { align: "left" },
      shortcut: "Mod-Shift-L",
    },
    {
      id: "align-center",
      label: "居中",
      command: "block.setAlign",
      input: { align: "center" },
      shortcut: "Mod-Shift-E",
    },
    {
      id: "align-right",
      label: "右对齐",
      command: "block.setAlign",
      input: { align: "right" },
      shortcut: "Mod-Shift-R",
    },
    {
      id: "align-justify",
      label: "两端对齐",
      command: "block.setAlign",
      input: { align: "justify" },
      shortcut: "Mod-Shift-J",
    },
  ],
  // 语言是开放集合，这里只列常见几种；命令本身接受任何合法标识符。
  "code-language": [
    { id: "lang-none", label: "无语言", command: "block.setCodeBlockLanguage", input: null },
    ...(
      [
        ["typescript", "TypeScript"],
        ["javascript", "JavaScript"],
        ["python", "Python"],
        ["rust", "Rust"],
        ["go", "Go"],
        ["java", "Java"],
        ["sql", "SQL"],
        ["bash", "Bash"],
        ["json", "JSON"],
        ["html", "HTML"],
        ["css", "CSS"],
      ] as const
    ).map(([language, label]) => ({
      id: `lang-${language}`,
      label,
      command: "block.setCodeBlockLanguage",
      input: { language },
    })),
  ],
  "list-ops": [
    { id: "checked", label: "勾选", command: "list.toggleChecked" },
    { id: "indent", label: "缩进", command: "list.indent", shortcut: "Tab" },
    { id: "outdent", label: "提升", command: "list.outdent", shortcut: "Shift-Tab" },
  ],
  "table-ops": [
    {
      id: "insert-table",
      label: "插入 3×3 表格",
      command: "table.insert",
      input: { rows: 3, cols: 3, withHeaderRow: true },
    },
    { id: "add-row", label: "加行", command: "table.addRowAfter" },
    { id: "add-column", label: "加列", command: "table.addColumnAfter" },
    { id: "merge-cells", label: "合并单元格", command: "table.mergeCells" },
    { id: "split-cell", label: "拆分单元格", command: "table.splitCell" },
    { id: "delete-table", label: "删除表格", command: "table.delete" },
  ],
};

/**
 * 两个取色面板。前景色与背景色是两条独立命令，因此面板也各开各的，
 * 「清除」只清自己那一种颜色。
 */
const COLOR_MENUS: Record<string, ColorPickerMenu> = {
  "text-color": {
    label: "文字颜色",
    setCommand: "color.setText",
    unsetCommand: "color.unsetText",
    readCommand: "color.readText",
    fallback: "#d92d20",
  },
  "background-color": {
    label: "背景色",
    setCommand: "color.setBackground",
    unsetCommand: "color.unsetBackground",
    readCommand: "color.readBackground",
    // 背景色默认给半透明：整块实底会把文字压得读不出来。
    fallback: "#fef08acc",
  },
};

/**
 * 常用的留在工具栏上，成套的收进分类菜单。菜单触发器一律 alwaysEnabled：
 * 触发器自己不代表某条命令，能不能用要看菜单里那一条。
 */
const toolbarDefinition: ToolbarDefinition = {
  label: "编辑工具栏",
  groups: [
    {
      label: "段落样式",
      items: [
        {
          id: "block-style",
          label: "段落样式",
          command: "block.setParagraph",
          menu: true,
          alwaysEnabled: true,
        },
        {
          id: "align",
          label: "对齐",
          command: "block.setAlign",
          menu: true,
          alwaysEnabled: true,
        },
        {
          id: "code-language",
          label: "代码语言",
          command: "block.setCodeBlockLanguage",
          menu: true,
          alwaysEnabled: true,
        },
      ],
    },
    {
      label: "列表",
      items: [
        {
          id: "bullet-list",
          label: "无序列表",
          command: "list.toggleBullet",
          shortcut: "Mod-Shift-8",
        },
        {
          id: "ordered-list",
          label: "有序列表",
          command: "list.toggleOrdered",
          shortcut: "Mod-Shift-9",
        },
        { id: "task-list", label: "待办列表", command: "list.toggleTask", shortcut: "Mod-Shift-7" },
        {
          id: "list-ops",
          label: "列表操作",
          command: "list.indent",
          menu: true,
          alwaysEnabled: true,
        },
      ],
    },
    {
      label: "行内格式",
      items: [
        { id: "bold", label: "加粗", command: "format.bold", shortcut: "Mod-B" },
        { id: "italic", label: "斜体", command: "format.italic", shortcut: "Mod-I" },
        { id: "underline", label: "下划线", command: "format.underline", shortcut: "Mod-U" },
        { id: "strike", label: "删除线", command: "format.strikethrough", shortcut: "Mod-Shift-X" },
        { id: "inline-code", label: "行内代码", command: "format.code", shortcut: "Mod-E" },
        {
          id: "text-color",
          label: "文字颜色",
          command: "color.setText",
          menu: true,
          alwaysEnabled: true,
        },
        {
          id: "background-color",
          label: "背景色",
          command: "color.setBackground",
          menu: true,
          alwaysEnabled: true,
        },
        { id: "link", label: "链接", command: "link.set" },
        { id: "unlink", label: "取消链接", command: "link.unset" },
      ],
    },
    {
      label: "插入",
      items: [
        { id: "image", label: "图片", command: "image.insert", alwaysEnabled: true },
        {
          id: "table-ops",
          label: "表格",
          command: "table.insert",
          menu: true,
          alwaysEnabled: true,
        },
      ],
    },
    {
      label: "历史",
      items: [
        { id: "undo", label: "撤销", command: "history.undo", shortcut: "Mod-Z" },
        { id: "redo", label: "重做", command: "history.redo", shortcut: "Mod-Shift-Z" },
      ],
    },
  ],
};

/**
 * 工具栏按钮的图标。文字 label 不丢：它继续当 aria-label 和 tooltip，
 * 没有映射到图标的按钮自动回落成文字。
 */
const TOOLBAR_ICONS: Record<string, LucideIcon> = {
  "block-style": Type,
  align: TextAlignStart,
  "align-left": TextAlignStart,
  "align-center": TextAlignCenter,
  "align-right": TextAlignEnd,
  "align-justify": TextAlignJustify,
  "list-ops": ListChecks,
  "table-ops": Table,
  paragraph: Pilcrow,
  "heading-1": Heading1,
  "heading-2": Heading2,
  "heading-3": Heading3,
  "heading-4": Heading4,
  quote: TextQuote,
  "code-block": CodeXml,
  "code-language": Braces,
  rule: Minus,
  "bullet-list": List,
  "ordered-list": ListOrdered,
  "task-list": ListTodo,
  checked: SquareCheckBig,
  indent: ListIndentIncrease,
  outdent: ListIndentDecrease,
  bold: Bold,
  italic: Italic,
  underline: Underline,
  strike: Strikethrough,
  "inline-code": Code,
  "text-color": Baseline,
  "background-color": PaintBucket,
  link: Link,
  unlink: Unlink,
  image: Image,
  undo: Undo2,
  redo: Redo2,
  "insert-table": Table,
  "add-row": Rows3,
  "add-column": Columns3,
  "merge-cells": Merge,
  "split-cell": Split,
  "delete-table": Trash2,
};

const APPLE = /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent);

/** 把 ToolbarDefinition 里的 "Mod-Shift-X" 排成 tooltip 里能一眼扫的 "⌘⇧X"。 */
function formatShortcut(shortcut: string): string {
  const keys = shortcut.split("-");
  const last = keys.pop() ?? "";
  const modifiers = keys
    .map((key) => {
      if (key === "Mod") {
        return APPLE ? "⌘" : "Ctrl+";
      }
      if (key === "Shift") {
        return APPLE ? "⇧" : "Shift+";
      }
      if (key === "Alt") {
        return APPLE ? "⌥" : "Alt+";
      }
      return APPLE ? key : `${key}+`;
    })
    .join("");
  return `${modifiers}${last.length === 1 ? last.toUpperCase() : last}`;
}

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
    plugins: faulty
      ? [
          createLinkPlugin(),
          createTablePlugin(),
          createColorPlugin(),
          createImagePlugin({ uploader: playgroundUploader }),
          ...FAULTY_PLUGINS,
        ]
      : [
          createLinkPlugin(),
          createTablePlugin(),
          createColorPlugin(),
          createImagePlugin({ uploader: playgroundUploader }),
        ],
  });
  const result = editor.loadDocument(document);
  return { editor, unknownNodes: result.unknownNodes, faulty, baseDocument: document };
}

function ModeSwitch() {
  const editor = useEditor();
  const mode = useEditorSelector((snapshot) => snapshot.mode);
  return (
    <label className="field">
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
    <div className="banner banner-danger" role="status">
      <strong>部分功能暂时不可用，内容已保留：</strong>
      <ul>
        {errors.map((error, index) => (
          <li key={`${error.plugin}-${error.kind}-${error.item ?? index}`}>{error.message}</li>
        ))}
      </ul>
    </div>
  );
}

/** 状态槽位：每种状态同字号同高度，只换颜色和圆点，切换时不跳动。 */
function StatusStrip() {
  const editor = useEditor();
  const dirty = useEditorSelector((snapshot) => snapshot.dirty);
  const revision = useEditorSelector((snapshot) => snapshot.revision);
  const composing = useEditorSelector((snapshot) => snapshot.composing);
  // 直接问，不用 memo：runtime 已按内容变更缓存，重渲染时取回的是同一个对象。
  const stats = editor.getTextStats();
  return (
    <span className={dirty ? "status status-dirty" : "status"}>
      <span className="status-dot" />
      修订号 {revision} · {dirty ? "未保存" : "已保存"} ·{" "}
      <span title={`不含空白 ${stats.charactersWithoutWhitespace.toLocaleString()} 字`}>
        {stats.characters.toLocaleString()} 字
      </span>
      {composing ? <span className="status-composing"> · 输入法组合中，命令已暂停</span> : null}
    </span>
  );
}

/**
 * 菜单面板。模型只负责 Escape 与焦点归位，点空白关闭要宿主自己接。
 * 落在触发器上的按下不算「外部」，否则它会先关一次、再被 onClick 重开。
 */
function MenuPanel({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const owner = panel.current?.closest(".editor-toolbar-item");
      if (owner && !owner.contains(event.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onClose]);

  return (
    <div className="menu-panel" ref={panel}>
      {children}
    </div>
  );
}

function Chrome({
  onSave,
  onLoadSample,
  faulty,
  onToggleFault,
}: {
  onSave: () => void;
  onLoadSample: () => void;
  faulty: boolean;
  onToggleFault: (next: boolean) => void;
}) {
  const editor = useEditor();
  const imageInput = useRef<HTMLInputElement>(null);

  return (
    <div className="chrome">
      <EditorToolbar
        className="toolbar"
        definition={toolbarDefinition}
        nativeTooltip={false}
        renderLabel={(item) => {
          const Icon = TOOLBAR_ICONS[item.id];
          return (
            <>
              {Icon ? <Icon aria-hidden="true" size={16} strokeWidth={1.75} /> : item.label}
              {item.menu ? <ChevronDown aria-hidden="true" size={12} strokeWidth={2} /> : null}
              {/* 按钮的可访问名由 aria-label 给，这层纯装饰，读屏不该再念一遍。 */}
              <span aria-hidden="true" className="tip">
                {item.label}
                {item.shortcut ? <kbd>{formatShortcut(item.shortcut)}</kbd> : null}
              </span>
            </>
          );
        }}
        renderMenu={(item, close) => {
          const colorMenu = COLOR_MENUS[item.id];
          return (
            <MenuPanel onClose={close}>
              {colorMenu ? <ColorPicker menu={colorMenu} onClose={close} /> : null}
              {(TOOLBAR_MENUS[item.id] ?? []).map((entry) => {
                const query = editor.queryCommand(entry.command, entry.input);
                const Icon = TOOLBAR_ICONS[entry.id];
                return (
                  <button
                    className="menu-item"
                    data-active={query.active}
                    disabled={!query.enabled}
                    key={entry.id}
                    onClick={() => {
                      editor.execute(entry.command, entry.input);
                      close();
                    }}
                    onMouseDown={(event) => event.preventDefault()}
                    role="menuitem"
                    type="button"
                  >
                    {Icon ? <Icon aria-hidden="true" size={15} strokeWidth={1.75} /> : null}
                    <span className="menu-item-label">{entry.label}</span>
                    {entry.shortcut ? <kbd>{formatShortcut(entry.shortcut)}</kbd> : null}
                  </button>
                );
              })}
            </MenuPanel>
          );
        }}
        onExecute={(item) => {
          if (item.id === "link") {
            const href = window.prompt("链接地址（仅 https/http/mailto/tel）", "https://");
            if (href) {
              editor.execute("link.set", { href });
            }
            return true;
          }
          if (item.id === "image") {
            imageInput.current?.click();
            return true;
          }
        }}
      />
      <input
        ref={imageInput}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          if (file) {
            const alt = window.prompt("图片替代文本", file.name);
            if (alt !== null) {
              editor.execute("image.insert", { file, alt });
            }
          }
          event.currentTarget.value = "";
        }}
      />
      <div className="env">
        <ModeSwitch />
        <button type="button" className="action action-primary" onClick={onSave}>
          <Save aria-hidden="true" size={14} strokeWidth={1.75} />
          保存
        </button>
        <button type="button" className="action" onClick={onLoadSample}>
          <FlaskConical aria-hidden="true" size={14} strokeWidth={1.75} />
          装载含未知节点的示例
        </button>
        <label className="field" title="重名、缺依赖、循环依赖、覆盖核心命令、命令抛错">
          <input
            type="checkbox"
            checked={faulty}
            onChange={(event) => onToggleFault(event.target.checked)}
          />
          注入故障插件
        </label>
        {faulty ? (
          <button
            type="button"
            className="action action-danger"
            onClick={() => editor.execute("fault.crash")}
          >
            <Zap aria-hidden="true" size={14} strokeWidth={1.75} />
            触发插件故障
          </button>
        ) : null}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
    <details className="console">
      <summary>
        <ChevronRight aria-hidden="true" className="disclosure" size={14} strokeWidth={2} />
        <span className="console-title">DocumentPatch 增量流</span>
        <span>{patches.length} 条</span>
        <StatusStrip />
      </summary>
      <div className="console-body">
        <p>
          {patches.length === 0
            ? "编辑后会显示增量，不会输出全文。"
            : `已捕获 ${patches.length} 条 patch。`}
        </p>
        <button
          type="button"
          className="action"
          onClick={replayAll}
          disabled={patches.length === 0}
        >
          从初始文档重放全部 patch
        </button>
        {patches.length > 0 ? <pre>{JSON.stringify(patches, null, 2)}</pre> : null}
        {replay ? <pre>{replay}</pre> : null}
      </div>
    </details>
  );
}

/**
 * Markdown 导入导出。
 *
 * 导出走 `editor.getMarkdown()`；导入是宿主自己把解析器和编辑器接起来——
 * 解析依赖装在可选包 `@kaelen/editor-markdown` 里，不进内核（方案 §4.3）。
 */
function MarkdownPanel() {
  const editor = useEditor();
  const [draft, setDraft] = useState("");
  const [notes, setNotes] = useState<string[]>([]);

  function exportMarkdown() {
    setDraft(editor.getMarkdown());
    setNotes([]);
  }

  function importMarkdown() {
    const imported = markdownToDocument(draft, editor.getSchemaExtensions());
    // 保留信封的版本与插件记录，只换文档体。
    const result = editor.loadDocument({ ...editor.getDocument(), doc: imported.doc });
    setNotes([
      result.ok ? "已导入。" : `导入失败：${result.errors?.join("；") ?? "未知错误"}`,
      ...imported.degrades.map((degrade) => `${degrade.message}（${degrade.count} 处）`),
    ]);
  }

  return (
    <details className="console">
      <summary>
        <ChevronRight aria-hidden="true" className="disclosure" size={14} strokeWidth={2} />
        <span className="console-title">Markdown 导入导出</span>
      </summary>
      <div className="console-body">
        <p>
          导出是有损的：颜色、对齐、下划线、图片的裁剪旋转、单元格合并在 Markdown
          里没有写法，只留文字与结构，文档本身一字未动。导入时图片一律降级为链接——
          远端图片必须先经服务端转存才能进文档。
        </p>
        <div className="env">
          <button type="button" className="action" onClick={exportMarkdown}>
            从当前文档导出
          </button>
          <button
            type="button"
            className="action action-primary"
            onClick={importMarkdown}
            disabled={draft.length === 0}
          >
            导入并替换文档
          </button>
        </div>
        <textarea
          className="markdown-draft"
          value={draft}
          spellCheck={false}
          rows={12}
          onChange={(event) => setDraft(event.target.value)}
          aria-label="Markdown 文本"
          placeholder="点“从当前文档导出”，或直接在这里粘贴一份 Markdown 再导入。"
        />
        {notes.length > 0 ? (
          <ul>
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </details>
  );
}

export function App() {
  const [boot, setBoot] = useState<Boot>(() => bootEditor(false, readStoredDocument()));
  const [saved, setSaved] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { editor, unknownNodes, faulty, baseDocument } = boot;

  // 规模与剪贴板策略的提示汇到同一处：对用户来说它们是同一件事——
  // "这次写入没做成，原因是什么"。
  useEffect(() => {
    setNotice(null);
    const unsubscribes = [
      editor.subscribe("limitExceeded", (limit) => setNotice(limit.message)),
      editor.subscribe("clipboardNotice", (clipboard) => setNotice(clipboard.message)),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe();
      }
    };
  }, [editor]);

  function save() {
    // 2MB 是存储契约（方案 §14.2）。宿主必须在写之前拒绝，写进去再发现就晚了。
    const size = editor.getDocumentSize();
    if (size > DOCUMENT_JSON_LIMIT_BYTES) {
      setNotice(
        `文档 ${formatBytes(size)} 超过 ${formatBytes(DOCUMENT_JSON_LIMIT_BYTES)} 上限，未保存。` +
          "请拆分文档或删除部分内容后重试。",
      );
      return;
    }
    const text = stringifyEnvelope(editor.getDocument());
    window.localStorage.setItem(STORAGE_KEY, text);
    setSaved(text);
    setNotice(null);
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
      <main>
        <h1 className="page-title">富文本编辑器 · 输入规则、图片上传、组合态与插件熔断</h1>
        <details className="notes">
          <summary>
            <ChevronRight aria-hidden="true" className="disclosure" size={14} strokeWidth={2} />
            使用说明与快捷键
          </summary>
          <p className="notes-body">
            {
              "标题、引用、列表、待办、代码块、分隔线都在工具栏上，按钮的 tooltip 是对应快捷键；列表里 Tab / Shift+Tab 升降级，Shift+Enter 软换行。选中文字后在“文字颜色”“背景色”里挑一格上色，面板底部的“清除”只去掉这一种颜色，前景色和背景色互不影响。点“图片”选择本地文件，或把图片拖入/粘贴到编辑区：上传中会显示占位，完成后回填；上传期间继续编辑，目标位置会随事务迁移。复制上传中图片不会复制运行时 uploadId。图片插入后可以反复回去改：单击选中，图片上方浮出快捷条（旋转、环绕、替换、删除），双击进入编辑模态——在整幅原图上拖出裁剪框、挑滤镜、调尺寸与替代文本，预览用的就是文档渲染那一套推导，点“应用”才写入，撤销一步即可回到改之前。裁剪与旋转要靠上传服务返回的原始尺寸，拿不到尺寸时这两项会被禁用。输入 #、-、1.、> 或 ``` 加空格可触发结构规则；中文/日文等输入法组合期间工具栏会暂停，并在候选词确认后恢复。复制会把可还原的 Slice 写入 HTML 的 data-co-slice，粘贴时优先恢复它；Cmd/Ctrl+Shift+V 与代码块内粘贴始终只取纯文本。切换状态可以看只读态与禁用态的区别；点保存写入 localStorage，刷新页面内容仍在。勾选“注入故障插件”会装入一批坏掉的第三方插件：重名、缺依赖、循环依赖、覆盖核心命令、命令抛错，用来看熔断，每种坏法都只让它自己失效。文档规模上限也在这里能看到：节点数超过 20000 的插入由编辑器在事务入口拒绝，超过 2MB 的文档由本页在写 localStorage 之前拒绝，两种都会在顶部提示，且都只拦新写入——已经超限的历史文档照常打得开。"
            }
          </p>
        </details>
        <DegradedBanner />
        {notice ? (
          <p className="banner banner-warn" role="status">
            {notice}
          </p>
        ) : null}
        {unknownNodes.length > 0 ? (
          <p className="banner banner-warn">
            部分内容以只读形式显示，需要这些功能才能编辑：{unknownNodes.join("、")}
            。保存时这些内容会原样写回，不会丢失。
          </p>
        ) : null}
        <div className="workbench">
          <Chrome
            onSave={save}
            onLoadSample={loadSample}
            faulty={faulty}
            onToggleFault={toggleFault}
          />
          <div className="stage">
            <div className="paper">
              <EditorContent />
            </div>
            <ImageToolbar />
          </div>
        </div>
        <PatchPanel baseDocument={baseDocument} />
        <MarkdownPanel />
        {saved ? (
          <details className="console">
            <summary>
              <ChevronRight aria-hidden="true" className="disclosure" size={14} strokeWidth={2} />
              <span className="console-title">已写入 localStorage 的文档</span>
            </summary>
            <div className="console-body">
              <pre>{saved}</pre>
            </div>
          </details>
        ) : null}
      </main>
    </EditorProvider>
  );
}
