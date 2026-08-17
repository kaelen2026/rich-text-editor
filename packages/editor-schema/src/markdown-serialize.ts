import type {
  CoreMarkSpec,
  EditorEnvelope,
  MarkdownSerializeContext,
  MarkJSON,
  NodeJSON,
} from "@kaelen/editor-shared-types";
import { coreMarks, coreNodes } from "./core-spec";
import { escapeBlockText, escapeInline } from "./markdown-escape";
import type { RenderSchema } from "./render";

/**
 * 把版本化文档序列化成 Markdown。
 *
 * 和 `renderDocumentToHTML` 同一条路数，也放在同一个包里：只吃结构化 JSON、
 * 不碰 DOM、除工作区内部类型外零依赖，因此浏览器与 Node 产出同一份字节
 * （方案 §12.1）。反方向的解析需要一个 Markdown 解析器，那份依赖单独装在
 * `@kaelen/editor-markdown`——只导出的宿主不必为解析器付出体积。
 *
 * Markdown 是交换格式不是存储格式：它表达不了的结构一律丢格式不丢文字，
 * 存储仍以信封 JSON 为准（方案 §4.3）。
 */
export function documentToMarkdown(
  document: EditorEnvelope | NodeJSON,
  extensions: RenderSchema = {},
): string {
  const nodes = { ...coreNodes, ...extensions.nodes };
  const marks = { ...coreMarks, ...extensions.marks };
  const doc = "doc" in document ? document.doc : document;

  const context: MarkdownSerializeContext = {
    block: (node) => renderBlock(node),
    blocks: (list) => renderBlocks(list),
    inline: (list) => renderInline(list, 0, false),
    prefixLines,
    escapeText: escapeBlockText,
  };

  function renderBlocks(list: readonly NodeJSON[]): string {
    return list
      .map((node) => renderBlock(node))
      .filter((text) => text.length > 0)
      .join("\n\n");
  }

  function renderBlock(node: NodeJSON): string {
    const spec = nodes[node.type];
    if (spec?.toMarkdown) {
      return spec.toMarkdown({ attrs: node.attrs ?? {}, content: node.content ?? [] }, context);
    }
    // 没有 Markdown 表达的块（未装插件的节点、第三方没实现映射的节点）：
    // 结构丢掉，里面的文字照常往下渲染。宁可导出一段没有表格线的文字，
    // 也不能让一整张表在导出结果里消失。
    return renderBlocks(node.content ?? []);
  }

  function renderInline(list: readonly NodeJSON[], depth: number, literal: boolean): string {
    let out = "";
    let index = 0;
    while (index < list.length) {
      const node = list[index] as NodeJSON;
      const nodeMarks = serializableMarks(node);
      const mark = nodeMarks[depth];
      if (mark) {
        // 相邻且带同一个标记的节点合成一段再包围符号，否则
        // `**粗**` + `**体**` 会写成 `**粗****体**`，重新解析就断了。
        let end = index + 1;
        while (end < list.length && sameMarkAt(list[end] as NodeJSON, mark, depth)) {
          end += 1;
        }
        const spec = marks[mark.type] as CoreMarkSpec;
        const inner = renderInline(
          list.slice(index, end),
          depth + 1,
          literal || spec.markdownLiteral === true,
        );
        out += spec.toMarkdown?.({ attrs: mark.attrs ?? {} }, inner) ?? inner;
        index = end;
        continue;
      }
      out += renderLeaf(node, out, literal);
      index += 1;
    }
    return out;
  }

  function renderLeaf(node: NodeJSON, precedingOutput: string, literal: boolean): string {
    if (node.type === "text") {
      const value = node.text ?? "";
      if (literal) {
        return value;
      }
      const atLineStart = precedingOutput === "" || precedingOutput.endsWith("\n");
      return atLineStart ? escapeBlockText(value) : escapeInline(value);
    }
    const spec = nodes[node.type];
    if (spec?.toMarkdown) {
      return spec.toMarkdown({ attrs: node.attrs ?? {}, content: node.content ?? [] }, context);
    }
    // 行内节点没有映射时同样只丢格式：把里面的文字接着写出去。
    return renderInline(node.content ?? [], 0, literal);
  }

  /** 只有真的能写成 Markdown 的标记才参与分组；下划线一类直接当不存在。 */
  function serializableMarks(node: NodeJSON): MarkJSON[] {
    return (node.marks ?? []).filter((mark) => marks[mark.type]?.toMarkdown);
  }

  function sameMarkAt(node: NodeJSON, mark: MarkJSON, depth: number): boolean {
    const candidate = serializableMarks(node)[depth];
    return candidate !== undefined && sameMark(candidate, mark);
  }

  return `${renderBlocks(doc.content ?? [])}\n`;
}

/**
 * 同一个标记的判据是"类型和属性都一样"：两段不同 `href` 的链接必须各写各的，
 * 合并成一段就会把其中一个地址弄丢。
 */
function sameMark(left: MarkJSON, right: MarkJSON): boolean {
  return (
    left.type === right.type &&
    JSON.stringify(left.attrs ?? {}) === JSON.stringify(right.attrs ?? {})
  );
}

/**
 * 逐行加前缀。空行只写前缀去掉行尾空格——`"> "` 会在 diff 里留下看不见的
 * 尾随空格，而多数编辑器保存时又会把它删掉，于是文件每次提交都在抖。
 */
export function prefixLines(text: string, firstPrefix: string, restPrefix?: string): string {
  const rest = restPrefix ?? firstPrefix;
  return text
    .split("\n")
    .map((line, index) => {
      const prefix = index === 0 ? firstPrefix : rest;
      return line.length === 0 ? prefix.trimEnd() : prefix + line;
    })
    .join("\n");
}
