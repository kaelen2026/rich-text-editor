// @vitest-environment jsdom
import { createEditor } from "@kaelen/editor-api";
import { EditorProvider } from "@kaelen/editor-react";
import type { ToolbarDefinition } from "@kaelen/editor-ui-model";
import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { EditorToolbar } from "./editor-toolbar";

const definition: ToolbarDefinition = {
  label: "格式工具栏",
  groups: [
    {
      label: "文本格式",
      items: [
        { id: "bold", label: "加粗", command: "format.bold" },
        { id: "italic", label: "斜体", command: "format.italic" },
        { id: "disabled", label: "不可用", command: "missing.command" },
      ],
    },
  ],
};

describe("EditorToolbar", () => {
  it("通过自动无障碍扫描（颜色对比由浏览器视觉检查覆盖）", async () => {
    const editor = createEditor();
    document.documentElement.lang = "zh-CN";
    document.title = "格式工具栏测试";
    render(
      <main>
        <EditorProvider editor={editor}>
          <EditorToolbar definition={definition} />
        </EditorProvider>
      </main>,
    );

    const result = await axe.run(document, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });

  it("渲染 ARIA toolbar，并由方向键在可用命令间移动唯一 Tab 停靠点", () => {
    const editor = createEditor();
    render(
      <EditorProvider editor={editor}>
        <EditorToolbar definition={definition} />
      </EditorProvider>,
    );

    const toolbar = screen.getByRole("toolbar", { name: "格式工具栏" });
    const bold = screen.getByRole("button", { name: "加粗" });
    const italic = screen.getByRole("button", { name: "斜体" });
    const disabled = screen.getByRole("button", { name: "不可用" }) as HTMLButtonElement;

    expect(toolbar).toBeTruthy();
    expect(bold.tabIndex).toBe(0);
    expect(italic.tabIndex).toBe(-1);
    expect(disabled.disabled).toBe(true);

    fireEvent.focus(bold);
    fireEvent.keyDown(bold, { key: "ArrowRight" });
    expect(document.activeElement).toBe(italic);
    expect(italic.tabIndex).toBe(0);
  });

  it("在菜单中按 Escape 关闭并将焦点还给触发按钮", () => {
    const editor = createEditor();
    const menuDefinition: ToolbarDefinition = {
      label: "格式工具栏",
      groups: [
        {
          label: "样式",
          items: [
            {
              id: "heading",
              label: "标题",
              command: "block.setHeading",
              input: { level: 2 },
              menu: true,
            },
          ],
        },
      ],
    };
    render(
      <EditorProvider editor={editor}>
        <EditorToolbar
          definition={menuDefinition}
          renderMenu={() => <button type="button">二级标题</button>}
        />
      </EditorProvider>,
    );

    const trigger = screen.getByRole("button", { name: "标题" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "标题菜单" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
