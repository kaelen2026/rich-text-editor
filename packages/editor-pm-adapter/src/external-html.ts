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
    appendInlineChildren(document, paragraph, element, schema);
    appendIfMeaningful(parent, paragraph);
    return;
  }
  if (/^h[1-6]$/.test(tag)) {
    const heading = document.createElement(`h${Math.min(Number(tag[1]), 4)}`);
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
