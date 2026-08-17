/**
 * Markdown 转义。
 *
 * 转义的判据是"这个字符会不会被重新解析成结构"，不是"这个字符是不是标点"。
 * 过度转义会把中文正文写成一片反斜杠——`。`、`，` 在 Markdown 里没有任何
 * 结构含义，碰都不该碰。
 */

/** 任何位置都可能起结构作用的字符。 */
const INLINE_SPECIALS = /[\\`*_[\]<>&~|]/g;

/**
 * 只在行首起作用的结构：列表标记、标题、引用、分隔线。
 * 行中间的 `#` 或 `-` 是普通字符，转义它们只会污染正文。
 */
const LINE_START_MARKER = /^(\s*)([#>+\-*])/;
const LINE_START_ORDERED = /^(\s*)(\d{1,9})([.)])/;

/**
 * `_` 只有在词的边界上才构成强调。`snake_case_name` 里的下划线转义了反而更难读，
 * 而它本来就不会被解析成斜体。
 */
function needsEscape(char: string, index: number, text: string): boolean {
  if (char !== "_") {
    return true;
  }
  const before = text[index - 1];
  const after = text[index + 1];
  return !(before !== undefined && after !== undefined && /\w/.test(before) && /\w/.test(after));
}

/** 行内文本转义。不处理行首规则，那由 `escapeBlockText` 逐行追加。 */
export function escapeInline(text: string): string {
  return text.replace(INLINE_SPECIALS, (char, index: number) =>
    needsEscape(char, index, text) ? `\\${char}` : char,
  );
}

/**
 * 块级文本转义：行内规则加上行首规则。
 *
 * 段落里的一行如果恰好以 `- ` 开头，重新解析时会变成一个列表项——原文里那是
 * 一个减号，不是列表。
 */
export function escapeBlockText(text: string): string {
  return escapeInline(text)
    .split("\n")
    .map((line) =>
      line.replace(LINE_START_MARKER, "$1\\$2").replace(LINE_START_ORDERED, "$1$2\\$3"),
    )
    .join("\n");
}

/**
 * 表格单元格里的换行会直接把表格拆断，因此折成空格。
 * 这是 GFM 表格的固有限制：单元格是单行的。
 */
export function flattenTableCell(text: string): string {
  return text.replace(/\\?\n+/g, " ").trim();
}

/** 链接目标。空格和括号会破坏 `](…)` 的边界，用尖括号包起来最稳。 */
export function escapeLinkDestination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replaceAll("<", "%3C").replaceAll(">", "%3E")}>` : url;
}
