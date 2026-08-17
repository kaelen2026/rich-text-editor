import type { DocumentTextStats, EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";

/**
 * 统计文档的字数。
 *
 * 只数文本节点的内容：图片、表格、分隔线这类结构不产生字符，块之间也不补
 * 换行——字数是内容的量，不是排版的量。兜底节点里 `attrs.original` 保存的
 * 原始子树同样不计：它当前显示的是占位说明，不是用户的正文。
 */
export function countDocumentText(document: EditorEnvelope | NodeJSON): DocumentTextStats {
  const doc = "doc" in document ? document.doc : document;
  const texts: string[] = [];
  collectText(doc, texts);
  return countText(texts.join(""));
}

/**
 * 同一口径的字符串版本。持有活文档的一方（编辑器会话）可以直接取出全文，
 * 不必为了数字数先把整棵树序列化成 JSON。
 */
export function countText(text: string): DocumentTextStats {
  let characters = 0;
  let charactersWithoutWhitespace = 0;
  for (const segment of segments(text)) {
    characters += 1;
    if (!whitespace.test(segment)) {
      charactersWithoutWhitespace += 1;
    }
  }
  return { characters, charactersWithoutWhitespace };
}

/**
 * 先把全文拼起来再分段，而不是逐个文本节点分别数：ProseMirror 会按标记切分
 * 文本节点，一个"e + 组合重音"完全可能落在两个节点里，分开数就成了两个字。
 */
function collectText(node: NodeJSON, texts: string[]): void {
  if (node.text) {
    texts.push(node.text);
  }
  for (const child of node.content ?? []) {
    collectText(child, texts);
  }
}

const whitespace = /^\s+$/u;

/**
 * 字素簇分段。`Intl.Segmenter` 是唯一能把 ZWJ 表情序列、国旗和组合字符算作
 * 一个字的办法；环境没有它时退回按码位数，宁可在表情上多算，也不要报错。
 */
function segments(text: string): Iterable<string> {
  if (typeof Intl === "undefined" || !("Segmenter" in Intl)) {
    return text;
  }
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return { [Symbol.iterator]: () => iterateSegments(segmenter.segment(text)) };
}

function* iterateSegments(data: Intl.Segments): Generator<string> {
  for (const { segment } of data) {
    yield segment;
  }
}
