import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";

const LINK_MARK = "co_link";
const allowedProtocols = new Set(["https:", "http:", "mailto:", "tel:"]);

/** 首个可选插件：安全链接及其命令。 */
export function createLinkPlugin(): EditorPlugin {
  return {
    name: "link",
    version: "1.0.0",
    namespace: "co_",
    structureVersion: 1,
    extendSchema: (schema) => {
      schema.addMark(LINK_MARK, {
        attrs: { href: {} },
        // 外部 HTML 管线先做协议白名单校验，再让声明式映射读取 href；Schema
        // 本身仍没有可执行的 getAttrs 钩子，服务端可复用、也便于审计。
        parseDOM: [{ tag: "a", attrsFromDOM: { href: "href" } }],
        toDOM: (node) => {
          const href = safeHref(node.attrs.href);
          // 白名单必须在渲染处再判一次：文档可能来自 localStorage、服务端或导入，
          // 而同一个 toDOM 还要用于服务端渲染 HTML（方案 §12.1）。
          return href
            ? ["a", { href, rel: "noopener noreferrer" }, 0]
            : ["span", { "data-unsafe-link": "true" }, 0];
        },
      });
    },
    registerCommands: (commands) => {
      commands.add("link.set", setLinkCommand);
      commands.add("link.unset", unsetLinkCommand);
      commands.add("link.open", openLinkCommand);
    },
  };
}

const setLinkCommand: SessionCommand = {
  run(session, apply, input) {
    const href = hrefFrom(input);
    if (!href) {
      return { ok: false, reason: "invalid", detail: "链接协议仅支持 https/http/mailto/tel" };
    }
    const markType = session.markType(LINK_MARK);
    if (!markType) {
      return { ok: false, reason: "disabled" };
    }
    const ok = session.setMarkOverSelection(LINK_MARK, { href }, apply);
    return ok ? { ok: true } : { ok: false, reason: "disabled" };
  },
  enabled: (session) => setLinkCommand.run(session, false, { href: "https://example.invalid" }).ok,
  active: (session) => session.isMarkActive(LINK_MARK),
};

const unsetLinkCommand: SessionCommand = {
  run(session, apply) {
    const markType = session.markType(LINK_MARK);
    if (!markType) {
      return { ok: false, reason: "disabled" };
    }
    // 选区里没有链接时直接拒绝：否则 toggleMark 会走"添加"分支，
    // 用 create(undefined) 造出一个 href 为 null 的垃圾链接。
    if (!session.hasMarkInSelection(LINK_MARK)) {
      return { ok: false, reason: "disabled" };
    }
    const ok = session.removeMarkOverSelection(LINK_MARK, apply);
    return ok ? { ok: true } : { ok: false, reason: "disabled" };
  },
  enabled: (session) => session.hasMarkInSelection(LINK_MARK),
  active: (session) => session.isMarkActive(LINK_MARK),
};

const openLinkCommand: SessionCommand = {
  run(session) {
    const href = hrefFrom(session.markAttrsAtSelection(LINK_MARK));
    return href ? { ok: true, detail: { href } } : { ok: false, reason: "disabled" };
  },
  active: (session) => session.isMarkActive(LINK_MARK),
};

function hrefFrom(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("href" in input)) {
    return undefined;
  }
  return safeHref(input.href);
}

/** 协议白名单。命令输入与渲染两处都走它。 */
function safeHref(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return allowedProtocols.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
