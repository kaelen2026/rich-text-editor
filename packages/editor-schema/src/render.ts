import type {
  CoreMarkSpec,
  CoreNodeSpec,
  DomOutputSpec,
  EditorEnvelope,
  MarkJSON,
  NodeJSON,
} from "@kaelen/editor-shared-types";
import { coreMarks, coreNodes } from "./core-spec";

export interface RenderSchema {
  nodes?: Record<string, CoreNodeSpec>;
  marks?: Record<string, CoreMarkSpec>;
}

/**
 * 在不创建 DOM 的前提下，把版本化文档的节点树渲染成 HTML。
 *
 * 输入只接受结构化 JSON；外部 HTML 必须先在客户端走 Schema 解析管线，不能把
 * 不可信字符串交给服务端渲染器（方案 §11.3、§12.1）。
 */
export function renderDocumentToHTML(
  document: EditorEnvelope | NodeJSON,
  extensions: RenderSchema = {},
): string {
  const schema = {
    nodes: { ...coreNodes, ...extensions.nodes },
    marks: { ...coreMarks, ...extensions.marks },
  };
  const doc = "doc" in document ? document.doc : document;
  return renderNode(doc, schema);
}

interface ResolvedRenderSchema {
  nodes: Record<string, CoreNodeSpec>;
  marks: Record<string, CoreMarkSpec>;
}

function renderNode(node: NodeJSON, schema: ResolvedRenderSchema): string {
  const content = node.content?.map((child) => renderNode(child, schema)).join("") ?? "";
  const rendered =
    node.type === "doc"
      ? content
      : node.type === "text"
        ? escapeText(node.text ?? "")
        : renderNodeSpec(node, content, schema.nodes[node.type]);
  return (
    node.marks?.reduceRight((html, mark) => renderMark(mark, html, schema), rendered) ?? rendered
  );
}

function renderNodeSpec(node: NodeJSON, content: string, spec: CoreNodeSpec | undefined): string {
  if (!spec?.toDOM) {
    return unknownNodePlaceholder(node);
  }
  return renderOutputSpec(
    spec.toDOM({ attrs: node.attrs ?? {} }),
    content,
    (node.content?.length ?? 0) > 0,
  );
}

function renderMark(mark: MarkJSON, content: string, schema: ResolvedRenderSchema): string {
  const spec = schema.marks[mark.type];
  // 未安装标记在编辑器装载时会被降级为纯文本；直接调用渲染器时也采用相同行为。
  if (!spec?.toDOM) {
    return content;
  }
  return renderOutputSpec(spec.toDOM({ attrs: mark.attrs ?? {} }), content, true);
}

function renderOutputSpec(spec: DomOutputSpec, content: string, hasContent: boolean): string {
  const rendered = renderSpec(spec, content);
  if (hasContent && !rendered.contentHole) {
    throw new Error("包含内容的节点缺少 DOMOutputSpec 内容孔");
  }
  return rendered.html;
}

function renderSpec(spec: DomOutputSpec, content: string): { html: string; contentHole: boolean } {
  if (typeof spec === "string") {
    return { html: escapeText(spec), contentHole: false };
  }

  const [tag, ...children] = spec;
  assertSafeTag(tag);
  let attributes = "";
  let html = "";
  let contentHole = false;
  for (const [index, child] of children.entries()) {
    if (isAttributeMap(child)) {
      if (index !== 0 || attributes) {
        throw new Error(`DOMOutputSpec <${tag}> 的属性必须只出现一次且紧跟标签名`);
      }
      attributes = renderAttributes(child);
      continue;
    }
    if (child === 0) {
      if (contentHole) {
        throw new Error(`DOMOutputSpec <${tag}> 只能有一个内容孔`);
      }
      contentHole = true;
      html += content;
      continue;
    }
    const rendered = renderSpec(child, content);
    if (rendered.contentHole && contentHole) {
      throw new Error(`DOMOutputSpec <${tag}> 只能有一个内容孔`);
    }
    contentHole ||= rendered.contentHole;
    html += rendered.html;
  }
  return {
    html: isVoidTag(tag) ? `<${tag}${attributes}>` : `<${tag}${attributes}>${html}</${tag}>`,
    contentHole,
  };
}

function unknownNodePlaceholder(node: NodeJSON): string {
  const tag = node.content?.length ? "div" : "span";
  const nodeName = escapeAttribute(node.type);
  return `<${tag} data-unknown-node="${nodeName}" class="co-unknown" contenteditable="false">此内容需要「${escapeText(node.type)}」功能才能显示与编辑</${tag}>`;
}

function isAttributeMap(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function renderAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes)
    .filter(([name]) => isSafeAttributeName(name))
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
}

function isSafeAttributeName(name: string): boolean {
  return /^[A-Za-z_:][A-Za-z0-9:._-]*$/.test(name) && !name.toLowerCase().startsWith("on");
}

function assertSafeTag(tag: string): void {
  if (!/^[A-Za-z][A-Za-z0-9:-]*$/.test(tag)) {
    throw new Error(`非法 HTML 标签：${tag}`);
  }
}

function isVoidTag(tag: string): boolean {
  return new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]).has(tag.toLowerCase());
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replaceAll('"', "&quot;");
}
