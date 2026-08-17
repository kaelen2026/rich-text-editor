import type { EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";
import { createEditor } from "./editor";

function envelopeWith(doc: NodeJSON): EditorEnvelope {
  return { envelope: 1, schemaVersion: 1, plugins: {}, doc, annotations: [] };
}

function codeDocument(attrs?: Record<string, unknown>): EditorEnvelope {
  return envelopeWith({
    type: "doc",
    content: [
      {
        type: "code_block",
        ...(attrs ? { attrs } : {}),
        content: [{ type: "text", text: "const a = 1" }],
      },
    ],
  });
}

function codeBlockAttrs(editor: ReturnType<typeof createEditor>): Record<string, unknown> {
  const block = editor.getDocument().doc.content?.[0];
  return block?.attrs ?? {};
}

describe("代码块语言", () => {
  it("设置语言后渲染 data-language 与 code 的语言 class", () => {
    const editor = createEditor();
    editor.loadDocument(codeDocument());

    expect(editor.execute("block.setCodeBlockLanguage", "typescript").ok).toBe(true);

    expect(editor.getHTML()).toBe(
      '<pre data-language="typescript"><code class="language-typescript">const a = 1</code></pre>',
    );
    expect(codeBlockAttrs(editor).language).toBe("typescript");
  });

  it("没有语言的代码块渲染成与从前逐字节相同的 HTML", () => {
    const editor = createEditor();
    editor.loadDocument(codeDocument());

    expect(editor.getHTML()).toBe("<pre><code>const a = 1</code></pre>");
  });

  it("再设一次同一语言即清除，与标题按钮同一套开关语义", () => {
    const editor = createEditor();
    editor.loadDocument(codeDocument({ language: "rust" }));

    expect(editor.execute("block.setCodeBlockLanguage", "rust").ok).toBe(true);

    expect(codeBlockAttrs(editor).language).toBeNull();
    expect(editor.getHTML()).toBe("<pre><code>const a = 1</code></pre>");
  });

  it("工具栏据此高亮：只有当前语言是生效态", () => {
    const editor = createEditor();
    editor.loadDocument(codeDocument({ language: "python" }));

    expect(editor.queryCommand("block.setCodeBlockLanguage", "python").active).toBe(true);
    expect(editor.queryCommand("block.setCodeBlockLanguage", "go").active).toBe(false);
    expect(editor.queryCommand("block.setCodeBlockLanguage", "go").enabled).toBe(true);
  });

  it("不在代码块里时命令不可用", () => {
    const editor = createEditor();
    editor.loadDocument(
      envelopeWith({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "普通段落" }] }],
      }),
    );

    expect(editor.queryCommand("block.setCodeBlockLanguage", "typescript").enabled).toBe(false);
    expect(editor.execute("block.setCodeBlockLanguage", "typescript").ok).toBe(false);
  });

  it("语言名走字符白名单：注入构造不进文档，也就不进 HTML", () => {
    const editor = createEditor();
    editor.loadDocument(codeDocument());

    expect(editor.execute("block.setCodeBlockLanguage", '"><script>alert(1)</script>').ok).toBe(
      false,
    );
    expect(codeBlockAttrs(editor).language ?? null).toBeNull();
  });

  it("装载文档里的非法语言退回无语言，内容不受影响", () => {
    const editor = createEditor();
    editor.loadDocument(codeDocument({ language: "not a language!" }));

    expect(editor.getHTML()).toBe("<pre><code>const a = 1</code></pre>");
  });

  it("撤销一步回到设置语言之前", () => {
    const editor = createEditor();
    editor.loadDocument(codeDocument());
    editor.execute("block.setCodeBlockLanguage", "sql");

    editor.undo();

    expect(codeBlockAttrs(editor).language ?? null).toBeNull();
  });
});
