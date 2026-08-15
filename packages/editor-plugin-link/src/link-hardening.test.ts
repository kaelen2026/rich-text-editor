// @vitest-environment jsdom
import { createEditor } from "@kaelen/editor-api";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import type { EditorEnvelope, NodeJSON } from "@kaelen/editor-shared-types";
import { beforeEach, describe, expect, it } from "vitest";

function envelopeWith(doc: NodeJSON): EditorEnvelope {
  return { envelope: 1, schemaVersion: 1, plugins: {}, doc, annotations: [] };
}

function plainDoc(text = "普通文本"): NodeJSON {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function linkedDoc(href: string, text = "链接文本"): NodeJSON {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", marks: [{ type: "co_link", attrs: { href } }], text }],
      },
    ],
  };
}

function firstMark(envelope: EditorEnvelope) {
  return envelope.doc.content?.[0]?.content?.[0]?.marks?.[0];
}

describe("链接渲染的协议白名单", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
  });

  it("文档里带 javascript: 的链接不得渲染成可点链接，文本保留", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument(envelopeWith(linkedDoc("javascript:alert(document.cookie)", "看起来正常")));

    editor.mount(host);

    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(host.textContent).toContain("看起来正常");
  });

  it("合法协议的链接照常渲染并带防 tabnabbing 的 rel", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument(envelopeWith(linkedDoc("https://example.com")));

    editor.mount(host);

    const anchor = host.querySelector("a");
    expect(anchor?.getAttribute("href")).toBe("https://example.com/");
    expect(host.textContent).toContain("链接文本");
    expect(anchor?.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("link.unset", () => {
  it("选区没有链接时不创建垃圾链接，也不报成功", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument(envelopeWith(plainDoc()));
    editor.execute("selection.selectAll");
    const before = editor.getDocument();

    const result = editor.execute("link.unset");

    expect(result.ok).toBe(false);
    expect(editor.getDocument()).toEqual(before);
    expect(editor.queryCommand("link.unset").enabled).toBe(false);
  });

  it("选区有链接时正常移除", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument(envelopeWith(linkedDoc("https://example.com")));
    editor.execute("selection.selectAll");

    expect(editor.execute("link.unset").ok).toBe(true);
    expect(firstMark(editor.getDocument())).toBeUndefined();
  });
});

describe("link.set", () => {
  it("在已有链接上改 URL 是替换而不是删除", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });
    editor.loadDocument(envelopeWith(linkedDoc("https://old.example.com")));
    editor.execute("selection.selectAll");

    const result = editor.execute("link.set", { href: "https://new.example.com" });

    expect(result.ok).toBe(true);
    expect(firstMark(editor.getDocument())).toEqual({
      type: "co_link",
      attrs: { href: "https://new.example.com/" },
    });
  });
});

describe("插件与信封的对应关系", () => {
  it("装载时把已安装插件记进信封", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });

    editor.loadDocument(envelopeWith(plainDoc()));

    expect(editor.getDocument().plugins).toEqual({ link: 1 });
  });

  it("不覆盖文档里已记录的插件版本", () => {
    const editor = createEditor({ plugins: [createLinkPlugin()] });

    editor.loadDocument({ ...envelopeWith(plainDoc()), plugins: { link: 7 } });

    expect(editor.getDocument().plugins).toEqual({ link: 7 });
  });

  it("缺插件导致标记被丢弃时报告降级，宿主可据此提示", () => {
    const editor = createEditor();

    const result = editor.loadDocument(envelopeWith(linkedDoc("https://example.com")));

    expect(result.ok).toBe(true);
    expect(result.unknownMarks).toEqual(["co_link"]);
    expect(result.degraded).toBe(true);
  });
});
