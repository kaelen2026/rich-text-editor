import { createEditor } from "@kaelen/editor-api";
import type { DocumentMigration, EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";
import { describe, expect, it } from "vitest";

/** 在首个文本节点后追加标记，让迁移的执行顺序在文档里可观察。 */
function appendSuffix(envelope: EditorEnvelope, suffix: string): EditorEnvelope {
  const paragraph = envelope.doc.content?.[0];
  const textNode = paragraph?.content?.[0];
  if (!paragraph?.type || !textNode?.text) {
    return envelope;
  }
  return {
    ...envelope,
    doc: {
      ...envelope.doc,
      content: [
        { ...paragraph, content: [{ ...textNode, text: `${textNode.text}${suffix}` }] },
        ...(envelope.doc.content?.slice(1) ?? []),
      ],
    },
  };
}

function envelopeAt(schemaVersion: number): EditorEnvelope {
  return {
    envelope: 1,
    schemaVersion,
    plugins: {},
    doc: {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "原文" }] }],
    },
    annotations: [],
  };
}

function firstText(envelope: EditorEnvelope): string | undefined {
  return envelope.doc.content?.[0]?.content?.[0]?.text;
}

const legacyBareDoc: NodeJSON = {
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "旧格式文档" }] },
    { type: "co_embed", attrs: { url: "https://example.com" } },
  ],
};

describe("信封迁移", () => {
  it("装载没有信封的裸文档：补齐信封并保留未知节点", () => {
    const editor = createEditor();

    const result = editor.loadDocument(legacyBareDoc);

    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(true);

    const envelope = editor.getDocument();
    expect(envelope.envelope).toBe(1);
    expect(envelope.schemaVersion).toBe(1);
    expect(envelope.plugins).toEqual({});
    expect(envelope.annotations).toEqual([]);
    // 未知节点在迁移中原样透传，不参与任何结构改写。
    expect(envelope.doc.content?.[1]).toEqual({
      type: "co_embed",
      attrs: { url: "https://example.com" },
    });
  });

  it("已是当前版本的信封不算迁移", () => {
    const editor = createEditor();

    const result = editor.loadDocument({
      envelope: 1,
      schemaVersion: 1,
      plugins: {},
      doc: { type: "doc", content: [{ type: "paragraph" }] },
      annotations: [],
    });

    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(false);
  });
});

describe("迁移链", () => {
  const migrations: DocumentMigration[] = [
    // 刻意乱序注册：执行顺序应由 to 决定，不由注册顺序决定。
    { to: 3, irreversible: true, up: (envelope) => appendSuffix(envelope, "·三") },
    { to: 2, irreversible: true, up: (envelope) => appendSuffix(envelope, "·二") },
  ];

  it("按 to 从小到大依次执行，并把 schemaVersion 写到目标版本", () => {
    const editor = createEditor({ migrations });

    const result = editor.loadDocument(envelopeAt(1));

    expect(result.ok).toBe(true);
    expect(result.migrated).toBe(true);
    expect(firstText(editor.getDocument())).toBe("原文·二·三");
    expect(editor.getDocument().schemaVersion).toBe(3);
  });

  it("跳过已经应用过的步骤", () => {
    const editor = createEditor({ migrations });

    const result = editor.loadDocument(envelopeAt(2));

    expect(result.ok).toBe(true);
    expect(firstText(editor.getDocument())).toBe("原文·三");
    expect(editor.getDocument().schemaVersion).toBe(3);
  });

  it("已在目标版本时不执行任何步骤，也不算迁移", () => {
    const editor = createEditor({ migrations });

    const result = editor.loadDocument(envelopeAt(3));

    expect(result.migrated).toBe(false);
    expect(firstText(editor.getDocument())).toBe("原文");
  });
});

describe("迁移的拒绝路径", () => {
  it("文档版本高于本环境支持时拒绝装载，并说明该升级应用", () => {
    const editor = createEditor();

    const result = editor.loadDocument(envelopeAt(9));

    expect(result.ok).toBe(false);
    expect(result.errors?.join()).toContain("高于本环境支持");
  });

  it("迁移链有缺口时拒绝装载，不按错版本静默读入", () => {
    const editor = createEditor({
      migrations: [{ to: 3, irreversible: true, up: (envelope) => envelope }],
    });

    const result = editor.loadDocument(envelopeAt(1));

    expect(result.ok).toBe(false);
    expect(result.errors?.join()).toContain("缺口");
  });

  it("迁移未声明可逆性时，创建编辑器即失败", () => {
    expect(() => createEditor({ migrations: [{ to: 2, up: (envelope) => envelope }] })).toThrow(
      /可逆性/,
    );
  });

  it("既不是信封也不是文档节点的输入被拒绝", () => {
    const editor = createEditor();

    const result = editor.loadDocument({ type: "paragraph" });

    expect(result.ok).toBe(false);
    expect(result.errors?.join()).toContain("无法识别");
  });
});

describe("迁移失败的隔离", () => {
  it("迁移函数抛错时返回可诊断失败，而不是把异常抛给宿主", () => {
    const editor = createEditor({
      migrations: [
        {
          to: 2,
          irreversible: true,
          up: () => {
            throw new Error("迁移写坏了");
          },
        },
      ],
    });

    const result = editor.loadDocument(envelopeAt(1));

    expect(result.ok).toBe(false);
    expect(result.errors?.join()).toContain("迁移写坏了");
  });

  it("装载失败时保留原有文档，不留下半个状态", () => {
    const editor = createEditor();
    editor.loadDocument(envelopeAt(1));
    const before = firstText(editor.getDocument());

    const result = editor.loadDocument({ type: "paragraph" });

    expect(result.ok).toBe(false);
    expect(firstText(editor.getDocument())).toBe(before);
    expect(editor.execute("selection.selectAll").ok).toBe(true);
  });
});
