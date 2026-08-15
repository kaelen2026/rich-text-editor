// @vitest-environment jsdom
import { createEditor } from "@kaelen/editor-api";
import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { EditorContent, EditorProvider } from "./index";

describe("Vue 编辑器适配层", () => {
  it("挂载和卸载只管理视图，不销毁业务创建的实例", async () => {
    const editor = createEditor();
    const host = document.createElement("div");
    const app = createApp(
      defineComponent({
        setup: () => () =>
          h(
            EditorProvider,
            { editor },
            { default: () => h(EditorContent, { ariaLabel: "Vue 编辑器" }) },
          ),
      }),
    );

    app.mount(host);
    await nextTick();
    expect(host.querySelector(".ProseMirror")?.getAttribute("aria-label")).toBe("Vue 编辑器");

    app.unmount();
    expect(editor.getSnapshot().mounted).toBe(false);
    expect(editor.execute("selection.selectAll").ok).toBe(true);
  });
});
