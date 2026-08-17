import { coreMarks, coreNodes } from "@kaelen/editor-schema";
import type {
  CoreDOMAttributeRule,
  CoreMarkSpec,
  CoreNodeSpec,
  CoreParseRule,
  CoreTagParseRule,
  DomOutputSpec,
} from "@kaelen/editor-shared-types";
import {
  type DOMOutputSpec,
  type MarkSpec,
  type NodeSpec,
  type ParseRule,
  type Mark as ProseMirrorMark,
  type Node as ProseMirrorNode,
  Schema,
  type TagParseRule,
} from "prosemirror-model";

/**
 * 把平台自有的 Spec 装配为 ProseMirror Schema。
 *
 * 平台 Spec 的 `toDOM` 只能返回纯数据（`DomOutputSpec`），因此这里是唯一
 * 需要与 ProseMirror 打交道的地方；`editor-schema` 自身对 ProseMirror 与 DOM
 * 都零依赖（方案 §7.1）。
 */
export interface SchemaExtensions {
  nodes?: Record<string, CoreNodeSpec>;
  marks?: Record<string, CoreMarkSpec>;
}

export function buildSchema(extensions: SchemaExtensions = {}): Schema {
  return new Schema({
    nodes: mapSpecs({ ...coreNodes, ...extensions.nodes }, toNodeSpec),
    marks: mapSpecs({ ...coreMarks, ...extensions.marks }, toMarkSpec),
  });
}

function mapSpecs<TIn, TOut>(
  specs: Record<string, TIn>,
  map: (spec: TIn) => TOut,
): Record<string, TOut> {
  const mapped: Record<string, TOut> = {};
  for (const [name, spec] of Object.entries(specs)) {
    mapped[name] = map(spec);
  }
  return mapped;
}

/**
 * 渲染函数只收到 `{ attrs }`，拿不到 ProseMirror 节点。这个包装是"`toDOM`
 * 不得访问 `document` 或文档内部"这条约束的结构性保障，不只是约定。
 */
function toNodeSpec(spec: CoreNodeSpec): NodeSpec {
  const { toDOM, parseDOM, ...rest } = spec;
  if (!toDOM) {
    return { ...rest, parseDOM: parseDOM ? toTagParseRules(parseDOM) : undefined };
  }
  return {
    ...rest,
    parseDOM: parseDOM ? toTagParseRules(parseDOM) : undefined,
    toDOM: (node: ProseMirrorNode) => asDomOutputSpec(toDOM({ attrs: node.attrs })),
  };
}

function toMarkSpec(spec: CoreMarkSpec): MarkSpec {
  const { toDOM, parseDOM, ...rest } = spec;
  if (!toDOM) {
    return { ...rest, parseDOM: parseDOM ? toMarkParseRules(parseDOM) : undefined };
  }
  return {
    ...rest,
    parseDOM: parseDOM ? toMarkParseRules(parseDOM) : undefined,
    toDOM: (mark: ProseMirrorMark) => asDomOutputSpec(toDOM({ attrs: mark.attrs })),
  };
}

function toMarkParseRules(rules: readonly CoreParseRule[]): ParseRule[] {
  return rules.map((rule) => ("tag" in rule ? toTagParseRule(rule) : (rule as ParseRule)));
}

function toTagParseRules(rules: readonly CoreTagParseRule[]): TagParseRule[] {
  return rules.map(toTagParseRule);
}

function toTagParseRule(rule: CoreTagParseRule): TagParseRule {
  if (!rule.attrsFromDOM) {
    return rule as TagParseRule;
  }
  const { attrsFromDOM, attrs, ...rest } = rule;
  return {
    ...rest,
    getAttrs: (element: HTMLElement) => {
      // 常量属性先铺底：`getAttrs` 一旦存在，ProseMirror 就不再看 `rule.attrs`，
      // 少了这一步，`h2` 规则加上读取钩子后连自己的 `level` 都会丢。
      return {
        ...attrs,
        ...Object.fromEntries(
          Object.entries(attrsFromDOM).map(([attribute, source]) => {
            if (typeof source === "string") {
              return [attribute, element.getAttribute(source)];
            }
            return [attribute, readDOMAttribute(element, source)];
          }),
        ),
      };
    },
  };
}

/** 与 `editor-schema` 的语言白名单同一套字符集，见 `CoreDOMAttributeRule.type`。 */
const TOKEN_PATTERN = /^[a-z][a-z0-9+#._-]{0,31}$/;

function readDOMAttribute(element: HTMLElement, rule: CoreDOMAttributeRule): unknown {
  const raw = element.getAttribute(rule.attribute);
  if (rule.oneOf) {
    return raw !== null && rule.oneOf.includes(raw) ? raw : rule.default;
  }
  if (rule.type === "token") {
    return readToken(raw, rule);
  }
  if (rule.type !== "integer") {
    return raw ?? rule.default;
  }
  const value = raw ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value)) {
    return rule.default;
  }
  return Math.max(
    rule.min ?? Number.MIN_SAFE_INTEGER,
    Math.min(rule.max ?? Number.MAX_SAFE_INTEGER, value),
  );
}

function readToken(raw: string | null, rule: CoreDOMAttributeRule): unknown {
  if (raw === null) {
    return rule.default;
  }
  const candidates = rule.prefix
    ? raw
        .split(/\s+/)
        .filter((token) => token.startsWith(rule.prefix as string))
        .map((token) => token.slice((rule.prefix as string).length))
    : [raw.trim()];
  const token = candidates.map((value) => value.toLowerCase()).find((value) => value.length > 0);
  return token !== undefined && TOKEN_PATTERN.test(token) ? token : rule.default;
}

function asDomOutputSpec(spec: DomOutputSpec): DOMOutputSpec {
  return spec as DOMOutputSpec;
}
