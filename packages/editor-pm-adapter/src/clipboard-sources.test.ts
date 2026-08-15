import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CoreMarkSpec, CoreNodeSpec } from "@kaelen/editor-shared-types";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { createTablePlugin } from "../../editor-plugin-table/src/table-plugin";
import { parseExternalHTML } from "./external-html";
import { buildSchema } from "./schema";

const schema = sourceSchema();
const sources = ["word", "excel", "web", "feishu", "notion", "wechat", "google-docs"] as const;

describe("剪贴板来源 golden 语料库", () => {
  it.each(sources)("%s 的完整 MIME dump 解析结果保持稳定", async (source) => {
    const directory = resolve(import.meta.dirname, "../../../fixtures/clipboard");
    const [dumpText, goldenText] = await Promise.all([
      readFile(resolve(directory, `${source}.dump.json`), "utf8"),
      readFile(resolve(directory, `${source}.golden.json`), "utf8"),
    ]);
    const dump = JSON.parse(dumpText) as Record<string, string>;

    expect(dump).toHaveProperty("text/html");
    expect(dump).toHaveProperty("text/plain");
    expect(dump).toHaveProperty("application/x-company-editor+json");
    usingDOM(() => {
      expect(parseExternalHTML(schema, dump["text/html"] ?? "").content.toJSON()).toEqual(
        JSON.parse(goldenText),
      );
    });
  });
});

function sourceSchema() {
  const nodes: Record<string, CoreNodeSpec> = {};
  createTablePlugin().extendSchema?.({
    addNode: (name, spec) => {
      nodes[name] = spec;
    },
    addMark: (_name: string, _spec: CoreMarkSpec) => undefined,
  });
  return buildSchema({
    nodes,
    marks: {
      co_link: {
        attrs: { href: {} },
        parseDOM: [{ tag: "a", attrsFromDOM: { href: "href" } }],
        toDOM: () => ["a", 0],
      },
    },
  });
}

function usingDOM(run: () => void): void {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const oldDOMParser = globalThis.DOMParser;
  Object.assign(globalThis, { DOMParser: dom.window.DOMParser });
  try {
    run();
  } finally {
    Object.assign(globalThis, { DOMParser: oldDOMParser });
    dom.window.close();
  }
}
