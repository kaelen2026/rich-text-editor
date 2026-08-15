// @vitest-environment jsdom
import { createEditor, type EditorOptions } from "@kaelen/editor-api";
import { EditorProvider, useEditor, usePluginErrors } from "@kaelen/editor-react";
import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

type InstalledPlugins = NonNullable<EditorOptions["plugins"]>;

const faultyPlugins: InstalledPlugins = [
  { name: "orphan", version: "1.0.0", namespace: "co_", dependsOn: ["never-installed"] },
  {
    name: "fault",
    version: "1.0.0",
    namespace: "co_",
    registerCommands: (commands) =>
      commands.add("fault.crash", {
        run: () => {
          throw new Error("插件炸了");
        },
        active: () => false,
      }),
  },
];

function Banner() {
  const errors = usePluginErrors();
  return <span data-testid="banner">{errors.map((error) => error.plugin).join(",")}</span>;
}

function CrashButton() {
  const editor = useEditor();
  return (
    <button type="button" data-testid="crash" onClick={() => editor.execute("fault.crash")}>
      crash
    </button>
  );
}

describe("插件降级提示", () => {
  it("渲染启动期冲突，并在运行期熔断后更新", () => {
    const editor = createEditor({ plugins: faultyPlugins });
    render(
      <StrictMode>
        <EditorProvider editor={editor}>
          <Banner />
          <CrashButton />
        </EditorProvider>
      </StrictMode>,
    );

    // 启动期冲突发生在订阅之前，仍然要出现在首帧。
    expect(screen.getByTestId("banner").textContent).toBe("orphan");

    fireEvent.click(screen.getByTestId("crash"));

    expect(screen.getByTestId("banner").textContent).toBe("orphan,fault");
  });
});
