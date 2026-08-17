#!/usr/bin/env node
/**
 * 序列化函数不得触碰 DOM（方案 §7.1、§12.1）。
 *
 * 检查 `toDOM` 与 `toMarkdown` 两个属性：约束的理由是同一条——服务端要复用同一份
 * Schema 产出 HTML 和 Markdown，一个 `document.createElement` 就让整条路径只能在
 * 浏览器里跑。
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ts from "typescript";

const serializerProperties = new Set(["toDOM", "toMarkdown"]);
const forbiddenGlobals = new Set([
  "document",
  "window",
  "DOMParser",
  "HTMLElement",
  "Element",
  "Node",
]);
const sourceFiles = process.argv.slice(2);
const targets = sourceFiles.length > 0 ? sourceFiles : collectSourceFiles(resolve("packages"));
const errors = targets.flatMap(lintToDOMFile);

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}

function collectSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    return entry.name.endsWith(".test.ts") || ![".ts", ".tsx"].includes(extname(entry.name))
      ? []
      : [path];
  });
}

function lintToDOMFile(path) {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const errors = [];
  visit(source, (node) => {
    if (!ts.isPropertyAssignment(node)) return;
    const property = node.name.getText(source);
    if (!serializerProperties.has(property)) return;
    visit(node.initializer, (child) => {
      if (!ts.isIdentifier(child) || !forbiddenGlobals.has(child.text)) return;
      const { line, character } = source.getLineAndCharacterOfPosition(child.getStart(source));
      errors.push(
        `${path}:${line + 1}:${character + 1} ${property} 不能访问 DOM API: ${child.text}`,
      );
    });
  });
  return errors;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
