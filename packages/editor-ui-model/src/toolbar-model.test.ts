import {
  getFloatingToolbarState,
  type ToolbarDefinition,
  ToolbarModel,
} from "@kaelen/editor-ui-model";
import { describe, expect, it } from "vitest";

const definition: ToolbarDefinition = {
  label: "文本格式",
  groups: [
    {
      label: "样式",
      items: [
        { id: "paragraph", label: "正文", command: "block.setParagraph" },
        {
          id: "heading",
          label: "标题",
          command: "block.setHeading",
          input: { level: 2 },
          menu: true,
        },
      ],
    },
    {
      label: "行内格式",
      items: [
        { id: "bold", label: "加粗", command: "format.bold", shortcut: "Mod-B" },
        { id: "italic", label: "斜体", command: "format.italic" },
      ],
    },
  ],
};

describe("ToolbarModel", () => {
  it("从命令查询派生项的可用、生效和取值状态", () => {
    const model = new ToolbarModel(definition, (command) => {
      if (command === "format.bold") {
        return { enabled: true, active: true, value: "strong" };
      }
      if (command === "format.italic") {
        return { enabled: false, active: false };
      }
      return { enabled: true, active: false };
    });

    const [paragraph, heading, bold, italic] = model.snapshot.items;
    expect(paragraph).toMatchObject({ enabled: true, active: false, tabIndex: 0 });
    expect(heading).toMatchObject({ menu: true, expanded: false });
    expect(bold).toMatchObject({ active: true, value: "strong", shortcut: "Mod-B" });
    expect(italic).toMatchObject({ enabled: false, tabIndex: -1 });
  });

  it("以 roving tabindex 在可用项间循环，并让 Tab 离开整个工具栏", () => {
    const model = new ToolbarModel(definition, (command) => ({
      enabled: command !== "format.italic",
      active: false,
    }));

    expect(model.handleKey("ArrowRight")).toEqual({ type: "focus", itemId: "heading" });
    expect(model.handleKey("ArrowRight")).toEqual({ type: "focus", itemId: "bold" });
    expect(model.handleKey("ArrowRight")).toEqual({ type: "focus", itemId: "paragraph" });
    expect(model.handleKey("End")).toEqual({ type: "focus", itemId: "bold" });
    expect(model.handleKey("Tab")).toEqual({ type: "none" });
    expect(model.snapshot.items.map((item) => item.tabIndex)).toEqual([-1, -1, 0, -1]);
  });

  it("打开菜单后 Escape 关闭菜单并把焦点返回触发项", () => {
    const model = new ToolbarModel(definition, () => ({ enabled: true, active: false }));

    expect(model.toggleMenu("heading")).toEqual({ type: "openMenu", itemId: "heading" });
    expect(model.snapshot.openMenuId).toBe("heading");
    expect(model.handleKey("Escape")).toEqual({ type: "focus", itemId: "heading" });
    expect(model.snapshot.openMenuId).toBeUndefined();
  });
});

describe("getFloatingToolbarState", () => {
  it("仅在可编辑的非空选区显示，并把定位输入限制在视口内", () => {
    expect(
      getFloatingToolbarState({
        mode: "edit",
        selection: { empty: false },
        anchorRect: { top: 4, right: 20, bottom: 24, left: 0, width: 20, height: 20 },
        viewport: { width: 320, height: 200 },
        toolbarSize: { width: 180, height: 40 },
      }),
    ).toEqual({ visible: true, placement: "bottom", x: 8, y: 32 });
    expect(
      getFloatingToolbarState({
        mode: "readonly",
        selection: { empty: false },
        anchorRect: { top: 100, right: 120, bottom: 120, left: 100, width: 20, height: 20 },
        viewport: { width: 320, height: 200 },
        toolbarSize: { width: 180, height: 40 },
      }),
    ).toEqual({ visible: false });
  });
});
