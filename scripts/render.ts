import { readFileSync } from "node:fs";
import { createEditor } from "@kaelen/editor-api";
import { createColorPlugin } from "@kaelen/editor-plugin-color";
import { createImagePlugin } from "@kaelen/editor-plugin-image";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { createTablePlugin } from "@kaelen/editor-plugin-table";
import type { EditorEnvelope } from "@kaelen/editor-shared-types";

const FORMATS = ["html", "markdown"] as const;
type Format = (typeof FORMATS)[number];

const args = process.argv.slice(2);
const formatIndex = args.indexOf("--format");
const format = formatIndex === -1 ? "html" : args[formatIndex + 1];
const path = args.find(
  (value, index) => !value.startsWith("--") && (formatIndex === -1 || index !== formatIndex + 1),
);

if (!path || !isFormat(format)) {
  throw new Error(`用法：pnpm render <doc.json> [--format ${FORMATS.join("|")}]`);
}

// 只读取版本化 JSON。HTML 导入始终属于浏览器侧的 inert Schema 解析管线，
// 服务端不会接受或转发客户端 HTML。Markdown 同理：这里只导出，不导入。
const document = JSON.parse(readFileSync(path, "utf8")) as EditorEnvelope;
const editor = createEditor({
  plugins: [
    createLinkPlugin(),
    createTablePlugin(),
    createColorPlugin(),
    createImagePlugin({
      uploader: {
        upload: async () => {
          throw new Error("服务端渲染不会上传图片");
        },
      },
    }),
  ],
});
const result = editor.loadDocument(document);
if (!result.ok) {
  throw new Error(`无法渲染文档：${result.errors?.join("；") ?? "未知错误"}`);
}
process.stdout.write(format === "markdown" ? editor.getMarkdown() : editor.getHTML());

function isFormat(value: string | undefined): value is Format {
  return FORMATS.includes(value as Format);
}
