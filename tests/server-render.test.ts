import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import { createColorPlugin } from "@kaelen/editor-plugin-color";
import { createImagePlugin } from "@kaelen/editor-plugin-image";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { createTablePlugin } from "@kaelen/editor-plugin-table";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../fixtures/doc-full.json");

function createFullEditor() {
  return createEditor({
    plugins: [
      createLinkPlugin(),
      createTablePlugin(),
      createColorPlugin(),
      createImagePlugin({
        uploader: { upload: async () => ({ url: "" }) },
      }),
    ],
  });
}

/**
 * 图片的二次编辑（缩放、裁剪、滤镜、环绕）全部渲染成内联样式：导出的 HTML
 * 因此脱离本项目的样式表也保真，服务端与浏览器拿到的是同一份自足内容。
 */
const expectedHTML =
  '<h2>服务端渲染</h2><p style="text-align:center" data-align="center"><strong>粗体</strong>和<a href="https://example.com/docs" rel="noopener noreferrer">链接</a>，还有<span data-co-text-color="#d92d20" style="color: rgb(217, 45, 32);"><span data-co-background-color="#fef08a" style="background-color: rgb(254, 240, 138);">彩色文字</span></span></p><table><tbody><tr><th colspan="1" rowspan="1"><p>标题</p></th><th colspan="1" rowspan="1"><p>数值</p></th></tr><tr><td colspan="1" rowspan="1"><p>第一行</p></td><td colspan="1" rowspan="1"><p>42</p></td></tr></tbody></table><div class="co-image" data-align="right" data-rotate="0" style="float:right;margin:0 0 8px 16px;max-inline-size:100%"><div class="co-image-frame" style="position:relative;overflow:hidden;width:320px;max-inline-size:100%;aspect-ratio:320/180"><img src="https://cdn.example.com/image.png" alt="示例图片" style="position:absolute;left:-12.5%;top:-16.6667%;width:125%;height:166.6667%;max-inline-size:none;filter:grayscale(1)" width="640" height="480"></div></div>';

describe("服务端 HTML 渲染", () => {
  it("不依赖 DOM，也能渲染包含链接、表格和图片的版本化 JSON", () => {
    const editor = createFullEditor();
    const result = editor.loadDocument(JSON.parse(readFileSync(fixturePath, "utf8")));

    expect(result.ok).toBe(true);
    expect(globalThis.document).toBeUndefined();
    expect(editor.getHTML()).toBe(expectedHTML);
  });

  it("render CLI 只接收 JSON 文件并写出 HTML", () => {
    expect(execFileSync("pnpm", ["--silent", "render", fixturePath], { encoding: "utf8" })).toBe(
      expectedHTML,
    );
  });
});
