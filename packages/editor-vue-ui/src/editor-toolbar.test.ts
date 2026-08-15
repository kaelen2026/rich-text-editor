// @vitest-environment jsdom
import { createEditor } from "@kaelen/editor-api";
import { EditorProvider } from "@kaelen/editor-vue";
import { describe, expect, it } from "vitest";
import { createApp, defineComponent, h, nextTick } from "vue";
import { EditorToolbar } from "./index";

describe("Vue 工具栏", () => {
  it("复用工具栏模型并执行编辑器命令", async () => {
    const editor = createEditor();
    editor.loadDocument({
      envelope: 1,
      schemaVersion: 1,
      plugins: {},
      doc: {
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: "内容" }] }],
      },
      annotations: [],
    });
    editor.execute("selection.selectAll");
    const host = document.createElement("div");
    createApp(
      defineComponent({
        setup: () => () =>
          h(
            EditorProvider,
            { editor },
            {
              default: () =>
                h(EditorToolbar, {
                  definition: {
                    label: "格式",
                    groups: [
                      {
                        label: "文本",
                        items: [{ id: "bold", label: "加粗", command: "format.bold" }],
                      },
                    ],
                  },
                }),
            },
          ),
      }),
    ).mount(host);
    await nextTick();

    const button = host.querySelector<HTMLButtonElement>("button");
    button?.click();
    expect(editor.queryCommand("format.bold").active).toBe(true);
    expect(host.querySelector('[role="toolbar"]')).toBeTruthy();
  });
});
