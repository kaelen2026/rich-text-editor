import { readFileSync } from "node:fs";
import { createEditor } from "@kaelen/editor-api";
import { createImagePlugin } from "@kaelen/editor-plugin-image";
import { createLinkPlugin } from "@kaelen/editor-plugin-link";
import { createTablePlugin } from "@kaelen/editor-plugin-table";
import type { EditorEnvelope } from "@kaelen/editor-shared-types";

const path = process.argv[2];
if (!path) {
  throw new Error("用法：pnpm render <doc.json>");
}

// 只读取版本化 JSON。HTML 导入始终属于浏览器侧的 inert Schema 解析管线，
// 服务端不会接受或转发客户端 HTML。
const document = JSON.parse(readFileSync(path, "utf8")) as EditorEnvelope;
const editor = createEditor({
  plugins: [
    createLinkPlugin(),
    createTablePlugin(),
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
process.stdout.write(editor.getHTML());
