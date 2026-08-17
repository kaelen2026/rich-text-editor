import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";

/**
 * 一致性样例插件（方案 §16.5）。
 *
 * 存在的唯一目的是回答一句承诺：**新增一个能力插件不需要修改 Core 的私有实现。**
 *
 * 因此这个文件只 import 一样东西——`@kaelen/editor-runtime` 的公开入口。没有指向
 * 包内 `src` 的深路径、没有 ProseMirror、没有为它开的后门。它覆盖的是一个真实插件
 * 会用到的全部注册点：
 *
 * - 一个带属性的 `co_` 节点，自带 `parseDOM` / `toDOM` / `toMarkdown` 三种表达；
 * - 一个 `co_` 标记，同样三种表达俱全；
 * - 一条以插件名打头的命令，含 `enabled` / `active` 查询；
 * - 一条只读查询命令（只读态下仍可用）。
 *
 * 哪天这里面有一样只能靠内部 API 完成，这个文件就编译不过或跑不通——那正是需要被
 * 发现的时刻。它是一份可执行的承诺，不是示例代码。
 *
 * 命令刻意只用标记类能力：那是**完全不需要 ProseMirror 就能写完**的一档插件。
 * 需要操作节点结构的插件仍要走 `applySchemaCommand` 这类桥接接口，那是 §7.1 明确
 * 允许的——桥接类型止于插件层，不进业务 API。
 */

export const CALLOUT_NODE = "co_sample_callout";
export const HIGHLIGHT_MARK = "co_sample_highlight";

const TONES = ["info", "warn"] as const;
type Tone = (typeof TONES)[number];

function isTone(value: unknown): value is Tone {
  return typeof value === "string" && (TONES as readonly string[]).includes(value);
}

/** 开关语义：选区已整体高亮时再执行一次即取消，与核心的格式命令一致。 */
const toggleHighlight: SessionCommand = {
  run(session, apply) {
    if (!session.markType(HIGHLIGHT_MARK)) {
      return { ok: false, reason: "disabled" };
    }
    const ok = session.isMarkActive(HIGHLIGHT_MARK)
      ? session.removeMarkOverSelection(HIGHLIGHT_MARK, apply)
      : session.setMarkOverSelection(HIGHLIGHT_MARK, {}, apply);
    return ok ? { ok: true } : { ok: false, reason: "disabled" };
  },
  enabled: (session) =>
    Boolean(session.markType(HIGHLIGHT_MARK)) &&
    session.setMarkOverSelection(HIGHLIGHT_MARK, {}, false),
  active: (session) => session.isMarkActive(HIGHLIGHT_MARK),
};

/** 只读态也该能问"光标在不在提示框里"——查询不改文档。 */
const insideCallout: SessionCommand = {
  run: (session) =>
    session.isWithin(CALLOUT_NODE) ? { ok: true } : { ok: false, reason: "disabled" },
  active: (session) => session.isWithin(CALLOUT_NODE),
  readOnly: true,
};

export function createSamplePlugin(): EditorPlugin {
  return {
    name: "sample",
    version: "1.0.0",
    namespace: "co_",
    structureVersion: 1,
    extendSchema: (schema) => {
      schema.addNode(CALLOUT_NODE, {
        content: "block+",
        group: "block",
        defining: true,
        attrs: { tone: { default: "info" } },
        parseDOM: [
          {
            tag: "aside[data-tone]",
            attrsFromDOM: { tone: { attribute: "data-tone", oneOf: TONES, default: "info" } },
          },
        ],
        toDOM: (node) => [
          "aside",
          { "data-tone": isTone(node.attrs.tone) ? node.attrs.tone : "info" },
          0,
        ],
        // Markdown 没有提示框，退回引用块并把语气写进首行——丢结构不丢文字。
        toMarkdown: (node, context) =>
          context.prefixLines(
            `**${isTone(node.attrs.tone) ? node.attrs.tone : "info"}**\n\n${context.blocks(node.content)}`,
            "> ",
          ),
      });
      schema.addMark(HIGHLIGHT_MARK, {
        parseDOM: [{ tag: "mark" }],
        toDOM: () => ["mark", 0],
        toMarkdown: (_mark, content) => `==${content}==`,
      });
    },
    registerCommands: (commands) => {
      commands.add("sample.toggleHighlight", toggleHighlight);
      commands.add("sample.insideCallout", insideCallout);
    },
  };
}
