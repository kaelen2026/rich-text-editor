// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { createColorPlugin } from "@kaelen/editor-plugin-color";
import { createImagePlugin } from "@kaelen/editor-plugin-image";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { createTablePlugin } from "@kaelen/editor-plugin-table";
import { buildSchema } from "@kaelen/editor-pm-adapter";
import { resolvePlugins } from "@kaelen/editor-runtime";
import type { EditorEnvelope } from "@kaelen/editor-shared-types";
import { DOMSerializer, Node as ProseMirrorNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../fixtures/doc-full.json");

function plugins() {
  return [
    createLinkPlugin(),
    createTablePlugin(),
    createColorPlugin(),
    createImagePlugin({ uploader: { upload: async () => ({ url: "" }) } }),
  ];
}

/**
 * 图片的裁剪与缩放渲染成内联样式，而 `style` 一旦经过 CSSOM 就会被重新排版
 * （补空格、把 `0` 写成 `0px`），各引擎补法还不一样：ProseMirror 的序列化器走的是
 * `style.cssText`，服务端渲染器输出的则是原样字符串。两侧统一过一遍浏览器自己的
 * CSS 序列化器再比，比的仍然是标签、属性与属性顺序，只是不再计较声明的排版。
 * 服务端那一份的确切字节由 tests/server-render.test.ts 钉住。
 */
function normalizeInlineStyles(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  for (const element of container.querySelectorAll<HTMLElement>("[style]")) {
    element.style.cssText = element.getAttribute("style") ?? "";
  }
  return container.innerHTML;
}

describe("浏览器与服务端 HTML 一致", () => {
  it("用同一份 DOMOutputSpec 产出同一棵 DOM", () => {
    const envelope = JSON.parse(readFileSync(fixturePath, "utf8")) as EditorEnvelope;
    const resolution = resolvePlugins(plugins());
    const schema = buildSchema({ nodes: resolution.nodes, marks: resolution.marks });
    const fragment = DOMSerializer.fromSchema(schema).serializeFragment(
      ProseMirrorNode.fromJSON(schema, envelope.doc).content,
    );
    const host = document.createElement("div");
    host.append(fragment);

    const editor = createEditor({ plugins: plugins() });
    editor.loadDocument(envelope);

    expect(normalizeInlineStyles(editor.getHTML())).toBe(normalizeInlineStyles(host.innerHTML));
  });
});
