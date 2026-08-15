// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
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
    createImagePlugin({ uploader: { upload: async () => ({ url: "" }) } }),
  ];
}

describe("浏览器与服务端 HTML 一致", () => {
  it("用同一份 DOMOutputSpec 产出字节相同的 HTML", () => {
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

    expect(editor.getHTML()).toBe(host.innerHTML);
  });
});
