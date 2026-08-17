/**
 * Markdown 导入。
 *
 * 导出方向在 `@kaelen/editor-schema` 里——它不需要解析器，因此不该让只导出的
 * 宿主为一个 Markdown 解析器付出体积。这里一并转出 `documentToMarkdown`，
 * 两个方向都要的宿主只装这一个包就够。
 */
export { documentToMarkdown } from "@kaelen/editor-schema";
export { markdownToDocument } from "./parse";
