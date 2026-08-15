#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import ts from "typescript";

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
    if (!ts.isPropertyAssignment(node) || node.name.getText(source) !== "toDOM") return;
    visit(node.initializer, (child) => {
      if (!ts.isIdentifier(child) || !forbiddenGlobals.has(child.text)) return;
      const { line, character } = source.getLineAndCharacterOfPosition(child.getStart(source));
      errors.push(`${path}:${line + 1}:${character + 1} toDOM 不能访问 DOM API: ${child.text}`);
    });
  });
  return errors;
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}
