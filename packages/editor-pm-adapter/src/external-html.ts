import { DOMParser as ProseMirrorDOMParser, type Schema, Slice } from "prosemirror-model";

const blockedTags = new Set(["script", "style", "template", "noscript", "svg", "math"]);
const blockTags = new Set([
  "address",
  "article",
  "aside",
  "div",
  "dl",
  "fieldset",
  "figure",
  "figcaption",
  "footer",
  "form",
  "header",
  "main",
  "nav",
  "section",
]);
const allowedProtocols = new Set(["https:", "http:", "mailto:", "tel:"]);

/**
 * 将外部 HTML 解析为可插入的 Slice。
 *
 * 输入仅由 DOMParser 创建的 inert document 读取。我们从不把不可信字符串赋给
 * 活文档的 innerHTML；输出 DOM 也完全由白名单节点和 textContent 构建。
 */
export function parseExternalHTML(schema: Schema, html: string): Slice {
  if (!html || typeof DOMParser === "undefined") {
    return Slice.empty;
  }
  const source = new DOMParser().parseFromString(html, "text/html");
  const output = new DOMParser().parseFromString("", "text/html");
  for (const child of Array.from(source.body.childNodes)) {
    appendBlock(output, output.body, child, schema);
  }
  return ProseMirrorDOMParser.fromSchema(schema).parseSlice(output.body);
}

function appendBlock(document: Document, parent: HTMLElement, node: Node, schema: Schema): void {
  if (node.nodeType === 3) {
    if (node.textContent?.trim()) {
      const paragraph = document.createElement("p");
      paragraph.textContent = node.textContent;
      parent.appendChild(paragraph);
    }
    return;
  }
  if (node.nodeType !== 1) {
    return;
  }

  const element = node as Element;
  const tag = element.localName.toLowerCase();
  if (blockedTags.has(tag) || tag === "img") {
    return;
  }
  if (tag === "table") {
    if (hasTableSchema(schema)) {
      appendTable(document, parent, element, schema);
    } else {
      appendTextParagraph(document, parent, safeTextContent(element));
    }
    return;
  }
  if (tag === "p" || blockTags.has(tag)) {
    const paragraph = document.createElement("p");
    copyAlign(element, paragraph);
    appendInlineChildren(document, paragraph, element, schema);
    appendIfMeaningful(parent, paragraph);
    return;
  }
  if (/^h[1-6]$/.test(tag)) {
    const heading = document.createElement(`h${Math.min(Number(tag[1]), 4)}`);
    copyAlign(element, heading);
    appendInlineChildren(document, heading, element, schema);
    appendIfMeaningful(parent, heading);
    return;
  }
  if (tag === "ul" || tag === "ol") {
    const list = document.createElement(tag);
    for (const child of Array.from(element.children)) {
      if (child.localName.toLowerCase() === "li") {
        appendListItem(document, list, child, schema);
      }
    }
    if (list.childElementCount > 0) {
      parent.appendChild(list);
    } else {
      appendTextParagraph(document, parent, element.textContent);
    }
    return;
  }
  if (tag === "li") {
    appendTextParagraph(document, parent, safeTextContent(element));
    return;
  }
  if (tag === "blockquote") {
    const quote = document.createElement("blockquote");
    appendBlockChildren(document, quote, element, schema);
    if (quote.childElementCount > 0) {
      parent.appendChild(quote);
    }
    return;
  }
  if (tag === "pre") {
    const pre = document.createElement("pre");
    const language = externalLanguage(element);
    if (language) {
      pre.setAttribute("data-language", language);
    }
    pre.textContent = safeTextContent(element);
    appendIfMeaningful(parent, pre);
    return;
  }

  const paragraph = document.createElement("p");
  appendInline(document, paragraph, element, schema);
  appendIfMeaningful(parent, paragraph);
}

function hasTableSchema(schema: Schema): boolean {
  return Boolean(
    schema.nodes.co_table &&
      schema.nodes.co_table_row &&
      schema.nodes.co_table_cell &&
      schema.nodes.co_table_header,
  );
}

function appendTable(
  document: Document,
  parent: HTMLElement,
  source: Element,
  schema: Schema,
): void {
  const rows = Array.from(source.querySelectorAll("tr"));
  const cellCount = rows.reduce(
    (count, row) =>
      count +
      Array.from(row.children).filter((child) => {
        const tag = child.localName.toLowerCase();
        return tag === "td" || tag === "th";
      }).length,
    0,
  );
  if (cellCount === 0 || cellCount > 5000) {
    appendTextParagraph(document, parent, safeTextContent(source));
    return;
  }

  const table = document.createElement("table");
  const body = document.createElement("tbody");
  for (const sourceRow of rows) {
    const row = document.createElement("tr");
    for (const sourceCell of Array.from(sourceRow.children)) {
      const tag = sourceCell.localName.toLowerCase();
      if (tag !== "td" && tag !== "th") {
        continue;
      }
      const cell = document.createElement(tag);
      copyTableSpan(sourceCell, cell, "colspan");
      copyTableSpan(sourceCell, cell, "rowspan");
      appendBlockChildren(document, cell, sourceCell, schema);
      if (cell.childElementCount === 0) {
        cell.appendChild(document.createElement("p"));
      }
      row.appendChild(cell);
    }
    if (row.childElementCount > 0) {
      body.appendChild(row);
    }
  }
  if (body.childElementCount > 0) {
    table.appendChild(body);
    parent.appendChild(table);
  }
}

function copyTableSpan(
  source: Element,
  target: HTMLElement,
  attribute: "colspan" | "rowspan",
): void {
  const raw = Number(source.getAttribute(attribute));
  const value = Number.isInteger(raw) ? Math.max(1, Math.min(1000, raw)) : 1;
  target.setAttribute(attribute, String(value));
}

function appendBlockChildren(
  document: Document,
  parent: HTMLElement,
  source: Element,
  schema: Schema,
): void {
  let inline = document.createElement("p");
  const flushInline = () => {
    appendIfMeaningful(parent, inline);
    inline = document.createElement("p");
  };
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 1 && isBlockElement(child as Element)) {
      flushInline();
      appendBlock(document, parent, child, schema);
    } else {
      appendInline(document, inline, child, schema);
    }
  }
  flushInline();
}

function appendListItem(
  document: Document,
  parent: HTMLElement,
  source: Element,
  schema: Schema,
): void {
  const item = document.createElement("li");
  let paragraph = document.createElement("p");
  const flushParagraph = () => {
    appendIfMeaningful(item, paragraph);
    paragraph = document.createElement("p");
  };
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 1 && ["ul", "ol"].includes((child as Element).localName.toLowerCase())) {
      flushParagraph();
      appendBlock(document, item, child, schema);
    } else if (child.nodeType === 1 && isBlockElement(child as Element)) {
      flushParagraph();
      appendBlock(document, item, child, schema);
    } else {
      appendInline(document, paragraph, child, schema);
    }
  }
  flushParagraph();
  if (item.childElementCount === 0) {
    item.appendChild(document.createElement("p"));
  }
  parent.appendChild(item);
}

function appendInlineChildren(
  document: Document,
  parent: HTMLElement,
  source: Element,
  schema: Schema,
): void {
  for (const child of Array.from(source.childNodes)) {
    appendInline(document, parent, child, schema);
  }
}

function appendInline(document: Document, parent: HTMLElement, node: Node, schema: Schema): void {
  if (node.nodeType === 3) {
    parent.appendChild(document.createTextNode(node.textContent ?? ""));
    return;
  }
  if (node.nodeType !== 1) {
    return;
  }

  const element = node as Element;
  const tag = element.localName.toLowerCase();
  if (blockedTags.has(tag) || tag === "img" || tag === "table") {
    return;
  }
  if (tag === "br") {
    parent.appendChild(document.createElement("br"));
    return;
  }
  if (
    tag === "strong" ||
    tag === "b" ||
    tag === "em" ||
    tag === "i" ||
    tag === "u" ||
    tag === "s" ||
    tag === "del" ||
    tag === "code"
  ) {
    const allowed = document.createElement(tag);
    appendInlineChildren(document, allowed, element, schema);
    parent.appendChild(allowed);
    return;
  }
  if (tag === "a") {
    const href = safeHref(element.getAttribute("href"));
    if (href && schema.marks.co_link) {
      const link = document.createElement("a");
      link.setAttribute("href", href);
      appendInlineChildren(document, link, element, schema);
      parent.appendChild(link);
    } else {
      appendInlineChildren(document, parent, element, schema);
    }
    return;
  }
  appendInlineChildren(document, parent, element, schema);
}

/**
 * 把外部块的对齐搬到重建出来的块上。
 *
 * 重建的 DOM 里只留 `data-align` 这一个白名单化的值，源文档的 `style` 串一律不带过来：
 * 这条管线的前提就是"输出 DOM 完全由白名单节点构建"，放行任意样式会把它废掉。
 * `start`/`end` 归到 `left`/`right`，Schema 的取值白名单只认这四个物理方向。
 */
function copyAlign(source: Element, target: HTMLElement): void {
  // 读 style 用鸭子类型而不是 `instanceof HTMLElement`：解析出来的 inert document
  // 可能来自另一个 realm（测试里就是 JSDOM），跨 realm 的构造器判断一律为假。
  const inlineAlign = (source as Partial<HTMLElement>).style?.textAlign ?? "";
  const raw = (source.getAttribute("align") ?? inlineAlign).trim().toLowerCase();
  const align = externalAlignments.get(raw);
  if (align) {
    target.setAttribute("data-align", align);
  }
}

/**
 * 从外部代码块里认出语言。高亮器把它写在三个地方：`pre` 自己的 class、
 * `pre` 的 `data-language`，以及最常见的——内层 `code` 的 class（GitHub、
 * Prism、highlight.js 都是这个形状）。Schema 的解析规则只看元素自身，
 * 因此在这条重建管线里把语言提到 `pre` 上，让白名单化的值成为唯一入口。
 */
function externalLanguage(source: Element): string | null {
  const code = source.querySelector("code");
  const candidates = [
    source.getAttribute("data-language"),
    source.getAttribute("data-lang"),
    ...classLanguages(source),
    ...classLanguages(code),
  ];
  for (const candidate of candidates) {
    const language = candidate?.trim().toLowerCase();
    if (language && externalLanguagePattern.test(language)) {
      return language;
    }
  }
  return null;
}

function classLanguages(element: Element | null): string[] {
  const raw = element?.getAttribute("class");
  if (!raw) {
    return [];
  }
  return raw
    .split(/\s+/)
    .filter((token) => token.startsWith("language-") || token.startsWith("lang-"))
    .map((token) => token.slice(token.indexOf("-") + 1));
}

/** 与 Schema 的语言白名单同一套字符集。 */
const externalLanguagePattern = /^[a-z][a-z0-9+#._-]{0,31}$/;

/** 用 Map 而不是对象字面量：`align="constructor"` 不该查出一个原型上的值。 */
const externalAlignments = new Map([
  ["left", "left"],
  ["center", "center"],
  ["right", "right"],
  ["justify", "justify"],
  ["start", "left"],
  ["end", "right"],
]);

function appendTextParagraph(document: Document, parent: HTMLElement, text: string | null): void {
  const paragraph = document.createElement("p");
  paragraph.textContent = text ?? "";
  appendIfMeaningful(parent, paragraph);
}

function appendIfMeaningful(parent: HTMLElement, child: HTMLElement): void {
  if (child.textContent || child.querySelector("br")) {
    parent.appendChild(child);
  }
}

function safeTextContent(node: Node): string {
  if (node.nodeType === 3) {
    return node.textContent ?? "";
  }
  if (node.nodeType !== 1) {
    return "";
  }
  const element = node as Element;
  if (
    blockedTags.has(element.localName.toLowerCase()) ||
    element.localName.toLowerCase() === "img"
  ) {
    return "";
  }
  return Array.from(element.childNodes, safeTextContent).join("");
}

function isBlockElement(element: Element): boolean {
  const tag = element.localName.toLowerCase();
  return (
    blockTags.has(tag) ||
    tag === "p" ||
    tag === "blockquote" ||
    tag === "pre" ||
    tag === "ul" ||
    tag === "ol" ||
    tag === "li" ||
    tag === "table" ||
    /^h[1-6]$/.test(tag)
  );
}

function safeHref(value: string | null): string | undefined {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return allowedProtocols.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
