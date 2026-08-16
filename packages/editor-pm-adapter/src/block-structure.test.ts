import type { NodeJSON } from "@kaelen/editor-shared-types";
import { TextSelection } from "prosemirror-state";
import { describe, expect, it } from "vitest";
import { coreCommands } from "./commands";
import { buildSchema } from "./schema";
import { EditorSession } from "./session";

function paragraph(text: string): NodeJSON {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function doc(...blocks: NodeJSON[]): NodeJSON {
  return { type: "doc", content: blocks };
}

function createSession(...blocks: NodeJSON[]): EditorSession {
  return new EditorSession(buildSchema(), doc(...blocks.map((block) => block)));
}

/** 文档里第 n 个文本块内部的位置，按文档顺序。 */
function textblockPositions(session: EditorSession): number[] {
  const positions: number[] = [];
  session.applyCommand((state) => {
    state.doc.descendants((node, pos) => {
      if (node.isTextblock) {
        positions.push(pos + 1);
        return false;
      }
      return true;
    });
    return true;
  }, false);
  return positions;
}

/** 把光标放进第 index 个文本块；`through` 指定时选区延伸到那个块。 */
function focus(session: EditorSession, index: number, through = index): void {
  const positions = textblockPositions(session);
  const from = positions[index];
  const to = positions[through];
  if (from === undefined || to === undefined) {
    throw new Error(`文档里没有第 ${index} / ${through} 个文本块`);
  }
  session.applyCommand((state, dispatch) => {
    dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, from, to)));
    return true;
  }, true);
}

function run(session: EditorSession, command: string, input?: unknown): boolean {
  const spec = coreCommands[command];
  if (!spec) {
    throw new Error(`没有这个命令：${command}`);
  }
  return spec.run(session, true, input).ok;
}

function active(session: EditorSession, command: string, input?: unknown): boolean {
  const spec = coreCommands[command];
  if (!spec) {
    throw new Error(`没有这个命令：${command}`);
  }
  return spec.active(session, input);
}

function undo(session: EditorSession): void {
  run(session, "history.undo");
}

function redo(session: EditorSession): void {
  run(session, "history.redo");
}

function types(session: EditorSession): string[] {
  return (session.docJSON.content ?? []).map((node) => node.type);
}

describe("标题", () => {
  it("段落转 h1–h4 各级，再点一次同级变回段落", () => {
    for (const level of [1, 2, 3, 4]) {
      const session = createSession(paragraph("标题文本"));
      focus(session, 0);

      expect(run(session, "block.setHeading", { level })).toBe(true);
      expect(session.docJSON.content?.[0]).toMatchObject({
        type: "heading",
        attrs: { level },
      });
      expect(active(session, "block.setHeading", { level })).toBe(true);
      expect(active(session, "block.setHeading", { level: level === 1 ? 2 : 1 })).toBe(false);

      expect(run(session, "block.setHeading", { level })).toBe(true);
      expect(types(session)).toEqual(["paragraph"]);
    }
  });

  it("非法层级被拒绝且不改文档", () => {
    const session = createSession(paragraph("文本"));
    focus(session, 0);

    for (const input of [{ level: 0 }, { level: 5 }, { level: 1.5 }, "h1", undefined]) {
      const result = coreCommands["block.setHeading"]?.run(session, true, input);
      expect(result).toMatchObject({ ok: false, reason: "invalid" });
    }
    expect(types(session)).toEqual(["paragraph"]);
  });

  it("撤销回到段落，重做回到标题", () => {
    const session = createSession(paragraph("文本"));
    focus(session, 0);

    run(session, "block.setHeading", { level: 2 });
    undo(session);
    expect(types(session)).toEqual(["paragraph"]);

    redo(session);
    expect(session.docJSON.content?.[0]).toMatchObject({ type: "heading", attrs: { level: 2 } });
  });

  it("直接传数字与传 { level } 等价", () => {
    const session = createSession(paragraph("文本"));
    focus(session, 0);

    expect(run(session, "block.setHeading", 3)).toBe(true);
    expect(session.docJSON.content?.[0]).toMatchObject({ type: "heading", attrs: { level: 3 } });
  });
});

describe("引用", () => {
  it("包裹与取消，撤销恢复原结构", () => {
    const session = createSession(paragraph("被引用"));
    focus(session, 0);

    expect(run(session, "block.toggleBlockquote")).toBe(true);
    expect(types(session)).toEqual(["blockquote"]);
    expect(active(session, "block.toggleBlockquote")).toBe(true);

    expect(run(session, "block.toggleBlockquote")).toBe(true);
    expect(types(session)).toEqual(["paragraph"]);
    expect(active(session, "block.toggleBlockquote")).toBe(false);
  });

  it("撤销包裹回到裸段落", () => {
    const session = createSession(paragraph("被引用"));
    focus(session, 0);
    run(session, "block.toggleBlockquote");

    undo(session);
    expect(types(session)).toEqual(["paragraph"]);

    redo(session);
    expect(types(session)).toEqual(["blockquote"]);
  });

  it("跨段落选区整体包裹", () => {
    const session = createSession(paragraph("一"), paragraph("二"));
    focus(session, 0, 1);

    expect(run(session, "block.toggleBlockquote")).toBe(true);
    expect(session.docJSON.content?.[0]?.content).toHaveLength(2);
  });
});

describe("分隔线与换行", () => {
  it("插入分隔线，撤销后消失", () => {
    const session = createSession(paragraph("文本"));
    focus(session, 0);

    expect(run(session, "block.insertHorizontalRule")).toBe(true);
    expect(types(session)).toContain("horizontal_rule");

    undo(session);
    expect(types(session)).toEqual(["paragraph"]);
  });

  it("插入软换行", () => {
    const session = createSession(paragraph("文本"));
    focus(session, 0);

    expect(run(session, "block.insertHardBreak")).toBe(true);
    expect(session.docJSON.content?.[0]?.content?.[0]).toMatchObject({ type: "hard_break" });
  });

  it("代码块里不插 hard_break：那会往 text* 内容里塞非法节点", () => {
    const session = createSession(paragraph("代码"));
    focus(session, 0);
    run(session, "block.toggleCodeBlock");
    focus(session, 0);

    expect(run(session, "block.insertHardBreak")).toBe(false);
    expect(session.docJSON.content?.[0]?.content).toMatchObject([{ type: "text" }]);
  });
});

describe("代码块", () => {
  it("段落转代码块再转回来", () => {
    const session = createSession(paragraph("const a = 1"));
    focus(session, 0);

    expect(run(session, "block.toggleCodeBlock")).toBe(true);
    expect(types(session)).toEqual(["code_block"]);
    expect(active(session, "block.toggleCodeBlock")).toBe(true);

    expect(run(session, "block.toggleCodeBlock")).toBe(true);
    expect(types(session)).toEqual(["paragraph"]);
  });

  it("代码块内不接受标记", () => {
    const session = createSession(paragraph("代码"));
    focus(session, 0);
    run(session, "block.toggleCodeBlock");
    focus(session, 0);

    expect(run(session, "format.bold")).toBe(false);
    expect(session.docJSON.content?.[0]?.content?.[0]?.marks).toBeUndefined();
  });
});

describe("列表", () => {
  it("段落转无序列表，再点一次退回段落", () => {
    const session = createSession(paragraph("条目"));
    focus(session, 0);

    expect(run(session, "list.toggleBullet")).toBe(true);
    expect(types(session)).toEqual(["bullet_list"]);
    expect(active(session, "list.toggleBullet")).toBe(true);

    focus(session, 0);
    expect(run(session, "list.toggleBullet")).toBe(true);
    expect(types(session)).toEqual(["paragraph"]);
  });

  it("无序 ↔ 有序 ↔ 待办互转，内容不变", () => {
    const session = createSession(paragraph("甲"), paragraph("乙"));
    focus(session, 0, 1);
    run(session, "list.toggleBullet");
    expect(types(session)).toEqual(["bullet_list"]);

    focus(session, 0, 1);
    expect(run(session, "list.toggleOrdered")).toBe(true);
    expect(types(session)).toEqual(["ordered_list"]);
    expect(session.docJSON.content?.[0]?.content).toHaveLength(2);

    focus(session, 0, 1);
    expect(run(session, "list.toggleTask")).toBe(true);
    const list = session.docJSON.content?.[0];
    expect(list?.type).toBe("task_list");
    expect(list?.content?.every((item) => item.type === "task_item")).toBe(true);
    expect(list?.content?.[0]?.attrs).toMatchObject({ checked: false });

    // 文本一路都在。
    expect(JSON.stringify(session.docJSON)).toContain("甲");
    expect(JSON.stringify(session.docJSON)).toContain("乙");
  });

  it("撤销列表转换回到段落", () => {
    const session = createSession(paragraph("条目"));
    focus(session, 0);
    run(session, "list.toggleOrdered");

    undo(session);
    expect(types(session)).toEqual(["paragraph"]);

    redo(session);
    expect(types(session)).toEqual(["ordered_list"]);
  });

  it("第二项可以降级成子列表，升级回来还原层级", () => {
    const session = createSession(paragraph("一"), paragraph("二"));
    focus(session, 0, 1);
    run(session, "list.toggleBullet");

    focus(session, 1);
    expect(run(session, "list.indent")).toBe(true);
    const items = session.docJSON.content?.[0]?.content;
    expect(items).toHaveLength(1);
    expect(items?.[0]?.content?.[1]?.type).toBe("bullet_list");

    focus(session, 1);
    expect(run(session, "list.outdent")).toBe(true);
    expect(session.docJSON.content?.[0]?.content).toHaveLength(2);
  });

  it("首项没有可降级的父项，命令报不可用而不是弄坏结构", () => {
    const session = createSession(paragraph("唯一一项"));
    focus(session, 0);
    run(session, "list.toggleBullet");
    focus(session, 0);

    expect(run(session, "list.indent")).toBe(false);
    expect(session.docJSON.content?.[0]?.content).toHaveLength(1);
  });

  it("不在列表里时升降级命令不可用，Tab 因此仍然属于宿主", () => {
    const session = createSession(paragraph("普通段落"));
    focus(session, 0);

    expect(run(session, "list.indent")).toBe(false);
    expect(run(session, "list.outdent")).toBe(false);
  });
});

describe("待办项", () => {
  it("勾选与取消，跨项选区一起勾选", () => {
    const session = createSession(paragraph("甲"), paragraph("乙"));
    focus(session, 0, 1);
    run(session, "list.toggleTask");

    focus(session, 0);
    expect(active(session, "list.toggleChecked")).toBe(false);
    expect(run(session, "list.toggleChecked")).toBe(true);
    expect(active(session, "list.toggleChecked")).toBe(true);
    expect(session.docJSON.content?.[0]?.content?.[1]?.attrs).toMatchObject({ checked: false });

    focus(session, 0, 1);
    expect(run(session, "list.toggleChecked")).toBe(true);
    const items = session.docJSON.content?.[0]?.content ?? [];
    expect(items.every((item) => item.attrs?.checked === true)).toBe(true);

    expect(run(session, "list.toggleChecked")).toBe(true);
    const cleared = session.docJSON.content?.[0]?.content ?? [];
    expect(cleared.every((item) => item.attrs?.checked === false)).toBe(true);
  });

  it("不在待办项里时命令不可用", () => {
    const session = createSession(paragraph("段落"));
    focus(session, 0);

    expect(run(session, "list.toggleChecked")).toBe(false);
    expect(active(session, "list.toggleChecked")).toBe(false);
  });
});

describe("对齐", () => {
  function aligns(session: EditorSession): unknown[] {
    return (session.docJSON.content ?? []).map((node) => node.attrs?.align ?? null);
  }

  it("四种对齐都能设置，再点一次同一种回到默认", () => {
    for (const align of ["left", "center", "right", "justify"] as const) {
      const session = createSession(paragraph("文本"));
      focus(session, 0);

      expect(run(session, "block.setAlign", { align })).toBe(true);
      expect(aligns(session)).toEqual([align]);
      expect(active(session, "block.setAlign", { align })).toBe(true);
      expect(active(session, "block.setAlign", { align: "center" })).toBe(align === "center");

      expect(run(session, "block.setAlign", { align })).toBe(true);
      expect(aligns(session)).toEqual([null]);
    }
  });

  it("直接传字符串与传 { align } 等价，null 是恢复默认", () => {
    const session = createSession(paragraph("文本"));
    focus(session, 0);

    expect(run(session, "block.setAlign", "right")).toBe(true);
    expect(aligns(session)).toEqual(["right"]);

    expect(run(session, "block.setAlign", null)).toBe(true);
    expect(aligns(session)).toEqual([null]);
    // 已经是默认了，没有什么可清除的。
    expect(run(session, "block.setAlign", null)).toBe(false);
  });

  it("标题一并支持，跨块选区整体对齐", () => {
    const session = createSession(paragraph("甲"), paragraph("乙"));
    focus(session, 1);
    run(session, "block.setHeading", { level: 2 });

    focus(session, 0, 1);
    expect(run(session, "block.setAlign", { align: "center" })).toBe(true);
    expect(aligns(session)).toEqual(["center", "center"]);
    expect(active(session, "block.setAlign", { align: "center" })).toBe(true);
  });

  it("选区只有部分对齐时补齐而不是清除，与生效态语义一致", () => {
    const session = createSession(paragraph("甲"), paragraph("乙"));
    focus(session, 0);
    run(session, "block.setAlign", { align: "center" });

    focus(session, 0, 1);
    expect(active(session, "block.setAlign", { align: "center" })).toBe(false);
    expect(run(session, "block.setAlign", { align: "center" })).toBe(true);
    expect(aligns(session)).toEqual(["center", "center"]);
  });

  it("列表项与引用里的段落照常对齐", () => {
    const session = createSession(paragraph("条目"));
    focus(session, 0);
    run(session, "list.toggleBullet");

    expect(run(session, "block.setAlign", { align: "right" })).toBe(true);
    expect(session.docJSON.content?.[0]?.content?.[0]?.content?.[0]?.attrs).toMatchObject({
      align: "right",
    });
  });

  it("代码块没有对齐属性，命令在其中不可用", () => {
    const session = createSession(paragraph("代码"));
    focus(session, 0);
    run(session, "block.toggleCodeBlock");

    expect(run(session, "block.setAlign", { align: "center" })).toBe(false);
    expect(active(session, "block.setAlign", { align: "center" })).toBe(false);
    expect(coreCommands["block.setAlign"]?.enabled?.(session, { align: "center" })).toBe(false);
  });

  it("选区跨越代码块时只对齐能对齐的块", () => {
    const session = createSession(paragraph("代码"), paragraph("文本"));
    focus(session, 0);
    run(session, "block.toggleCodeBlock");

    focus(session, 0, 1);
    expect(run(session, "block.setAlign", { align: "center" })).toBe(true);
    expect(aligns(session)).toEqual([null, "center"]);
    // 代码块不参与判断，否则整段永远不可能"全部生效"。
    expect(active(session, "block.setAlign", { align: "center" })).toBe(true);
  });

  it("非法对齐被拒绝且不改文档", () => {
    const session = createSession(paragraph("文本"));
    focus(session, 0);

    for (const input of ["middle", { align: "middle" }, { align: 1 }, undefined]) {
      expect(coreCommands["block.setAlign"]?.run(session, true, input)).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    }
    expect(aligns(session)).toEqual([null]);
  });

  it("撤销一次回到对齐前", () => {
    const session = createSession(paragraph("甲"), paragraph("乙"));
    focus(session, 0, 1);

    run(session, "block.setAlign", { align: "justify" });
    expect(aligns(session)).toEqual(["justify", "justify"]);

    undo(session);
    expect(aligns(session)).toEqual([null, null]);
    redo(session);
    expect(aligns(session)).toEqual(["justify", "justify"]);
  });
});

describe("行内标记", () => {
  it("下划线、删除线、行内代码各自开关", () => {
    for (const [command, mark] of [
      ["format.underline", "underline"],
      ["format.strikethrough", "strikethrough"],
      ["format.code", "code"],
    ] as const) {
      const session = createSession(paragraph("文本"));
      focus(session, 0);
      session.applyCommand((state, dispatch) => {
        dispatch?.(state.tr.setSelection(TextSelection.create(state.doc, 1, 3)));
        return true;
      }, true);

      expect(run(session, command)).toBe(true);
      expect(active(session, command)).toBe(true);
      expect(session.docJSON.content?.[0]?.content?.[0]?.marks).toMatchObject([{ type: mark }]);

      expect(run(session, command)).toBe(true);
      expect(active(session, command)).toBe(false);
    }
  });
});
