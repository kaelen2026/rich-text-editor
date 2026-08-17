import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import type { DomOutputSpec } from "@kaelen/editor-shared-types";

/** 前景色（文字颜色）标记名。持久化名，永不改名。 */
export const TEXT_COLOR_MARK = "co_text_color";
/** 背景色（文字底色）标记名。 */
export const BACKGROUND_COLOR_MARK = "co_background_color";

/**
 * 颜色值只接受十六进制字面量，可带 alpha（`#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`）。
 *
 * `red`、`rgb()`、`var()` 一概拒绝：颜色最终要拼进 `style` 属性，放行任意
 * CSS 语法等于把声明块的写权交给文档来源（`red; background: url(...)`），
 * 而文档可能来自 localStorage、服务端或导入。
 */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/;

/**
 * 前景色与背景色。两个独立标记，因此可以同时生效、各自取消。
 *
 * 两个标记都不提供 `toMarkdown`：Markdown 没有颜色，退回 `<span style>` 等于
 * 把 HTML 塞进 Markdown。导出时按丢格式不丢文字处理，与卸载插件时的 §9.3
 * 兜底同一条立场（方案 §4.3）。
 */
export function createColorPlugin(): EditorPlugin {
  return {
    name: "color",
    version: "1.0.0",
    namespace: "co_",
    structureVersion: 1,
    extendSchema: (schema) => {
      schema.addMark(TEXT_COLOR_MARK, {
        attrs: { color: {} },
        // 只认自己写出的数据属性：外部 HTML 的 style 由粘贴管线统一剥除
        // （方案 §3「首期不保留外部网页或 Word 的字体、边距、颜色」），
        // 声明式映射也读不了 `style` 里的子串。
        parseDOM: [
          {
            tag: "span[data-co-text-color]",
            attrsFromDOM: { color: "data-co-text-color" },
          },
        ],
        toDOM: (mark) => colorSpan("color", "data-co-text-color", mark.attrs.color),
      });
      schema.addMark(BACKGROUND_COLOR_MARK, {
        attrs: { color: {} },
        parseDOM: [
          {
            tag: "span[data-co-background-color]",
            attrsFromDOM: { color: "data-co-background-color" },
          },
        ],
        toDOM: (mark) =>
          colorSpan("background-color", "data-co-background-color", mark.attrs.color),
      });
    },
    registerCommands: (commands) => {
      commands.add("color.setText", setColorCommand(TEXT_COLOR_MARK));
      commands.add("color.unsetText", unsetColorCommand(TEXT_COLOR_MARK));
      commands.add("color.readText", readColorCommand(TEXT_COLOR_MARK));
      commands.add("color.setBackground", setColorCommand(BACKGROUND_COLOR_MARK));
      commands.add("color.unsetBackground", unsetColorCommand(BACKGROUND_COLOR_MARK));
      commands.add("color.readBackground", readColorCommand(BACKGROUND_COLOR_MARK));
    },
  };
}

/**
 * 白名单必须在渲染处再判一次：命令入口拦不住手写 JSON 和历史文档，
 * 而同一个 `toDOM` 还要用于服务端渲染 HTML（方案 §12.1）。
 * 颜色不合法时只留下透明的 span，文字一个不丢。
 *
 * 声明写成 CSSOM 的规范形态（`rgb(r, g, b);`）而不是十六进制：浏览器侧
 * 由 DOMSerializer 经 `style.cssText` 落属性，会把 `#d92d20` 归一成
 * `rgb(217, 45, 32);`，服务端直接产出同一形态，两侧 HTML 才字节相同。
 * 持久化与数据属性仍是十六进制，那是文档的规范形态。
 */
function colorSpan(
  property: "color" | "background-color",
  attribute: string,
  value: unknown,
): DomOutputSpec {
  const color = safeColor(value);
  return color
    ? ["span", { [attribute]: color, style: `${property}: ${toCSSColor(color)};` }, 0]
    : ["span", 0];
}

/**
 * `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` → `rgb(r, g, b)` 或 `rgba(r, g, b, a)`。
 * 输入必须先过 `safeColor`。
 *
 * 不透明时刻意不写 `rgba(…, 1)`：CSSOM 会把它折回 `rgb()`，多写一个通道就不是
 * 浏览器那份字节了。alpha 从字节换算后保留两位小数，同样是为了让两侧写法一致。
 */
function toCSSColor(color: string): string {
  const digits = color.slice(1);
  const short = digits.length <= 4;
  const size = short ? 1 : 2;
  const channels: number[] = [];
  for (let index = 0; index < digits.length; index += size) {
    const pair = digits.slice(index, index + size);
    channels.push(Number.parseInt(short ? `${pair}${pair}` : pair, 16));
  }
  const [red = 0, green = 0, blue = 0, alphaByte = 255] = channels;
  if (alphaByte === 255) {
    return `rgb(${red}, ${green}, ${blue})`;
  }
  return `rgba(${red}, ${green}, ${blue}, ${Math.round((alphaByte / 255) * 100) / 100})`;
}

function setColorCommand(markName: string): SessionCommand {
  return {
    run(session, apply, input) {
      const color = colorFrom(input);
      if (!color) {
        return { ok: false, reason: "invalid", detail: "颜色仅支持 #rgb 或 #rrggbb 十六进制值" };
      }
      if (!session.markType(markName)) {
        return { ok: false, reason: "disabled" };
      }
      // setMarkOverSelection 是先清后加：同一位置换颜色不会退化成"取消上色"。
      return session.setMarkOverSelection(markName, { color }, apply)
        ? { ok: true }
        : { ok: false, reason: "disabled" };
    },
    // 可用性只取决于"有没有可上色的范围"，与具体颜色无关，因此用一个探针色去问。
    enabled: (session) =>
      Boolean(session.markType(markName)) &&
      session.setMarkOverSelection(markName, { color: "#000000" }, false),
    active: (session, input) => {
      if (!session.isMarkActive(markName)) {
        return false;
      }
      const color = colorFrom(input);
      // 不带颜色地问，问的是"选区是否已上色"；带颜色问的是"是不是这一个颜色"。
      return (
        color === undefined || safeColor(session.markAttrsAtSelection(markName)?.color) === color
      );
    },
  };
}

function unsetColorCommand(markName: string): SessionCommand {
  return {
    run(session, apply) {
      // 选区里没有该标记时直接拒绝，工具栏因此能把按钮置灰而不是让它空转。
      if (!session.hasMarkInSelection(markName)) {
        return { ok: false, reason: "disabled" };
      }
      return session.removeMarkOverSelection(markName, apply)
        ? { ok: true }
        : { ok: false, reason: "disabled" };
    },
    enabled: (session) => session.hasMarkInSelection(markName),
    active: (session) => session.isMarkActive(markName),
  };
}

/**
 * 读取选区当前的颜色，供取色面板打开时定位到"这段文字现在是什么色"。
 * 不改文档，因此只读态也可用。
 */
function readColorCommand(markName: string): SessionCommand {
  return {
    run(session) {
      const color = safeColor(session.markAttrsAtSelection(markName)?.color);
      return color ? { ok: true, detail: { color } } : { ok: false, reason: "disabled" };
    },
    active: (session) => session.isMarkActive(markName),
    readOnly: true,
  };
}

function colorFrom(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("color" in input)) {
    return undefined;
  }
  return safeColor(input.color);
}

/** 归一化为小写十六进制。命令入口与渲染两处都走它。 */
function safeColor(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const color = value.trim().toLowerCase();
  return HEX_COLOR.test(color) ? color : undefined;
}
