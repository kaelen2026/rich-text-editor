import type { EditorPlugin, SessionCommand } from "@kaelen/editor-runtime";
import { toggleMark } from "prosemirror-commands";

const LINK_MARK = "co_link";
const allowedProtocols = new Set(["https:", "http:", "mailto:", "tel:"]);

/** 首个可选插件：安全链接及其命令。 */
export function createLinkPlugin(): EditorPlugin {
  return {
    name: "link",
    version: "1.0.0",
    namespace: "co_",
    extendSchema: (schema) => {
      schema.addMark(LINK_MARK, {
        attrs: { href: {} },
        parseDOM: [{ tag: "a[href]" }],
        toDOM: (node) => ["a", { href: String(node.attrs.href), rel: "noopener noreferrer" }, 0],
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
    const ok = session.applyCommand(
      toggleMark(markType, { href }, { removeWhenPresent: false }),
      apply,
    );
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
    const ok = session.applyCommand(toggleMark(markType), apply);
    return ok ? { ok: true } : { ok: false, reason: "disabled" };
  },
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
  const href = input.href;
  if (typeof href !== "string") {
    return undefined;
  }
  try {
    const url = new URL(href);
    return allowedProtocols.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
