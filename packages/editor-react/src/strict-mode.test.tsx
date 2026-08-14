// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createEditor } from "@kaelen/editor-api";
import {
  EditorContent,
  EditorProvider,
  useCommandQuery,
  useEditor,
  useEditorSelector,
} from "@kaelen/editor-react";
import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it } from "vitest";

const fixturePath = resolve(import.meta.dirname, "../../../fixtures/doc-basic.json");
const fixtureText = readFileSync(fixturePath, "utf8").trimEnd();

function RevisionBadge() {
  const revision = useEditorSelector((snapshot) => snapshot.revision);
  return <span data-testid="revision">{revision}</span>;
}

function BoldButton() {
  const editor = useEditor();
  const { active } = useCommandQuery("format.bold");
  return (
    <button
      type="button"
      data-testid="bold"
      data-active={active}
      onClick={() => {
        editor.execute("selection.selectAll");
        editor.execute("format.bold");
      }}
    >
      B
    </button>
  );
}

function renderEditor() {
  const editor = createEditor();
  editor.loadDocument(JSON.parse(fixtureText));
  render(
    <StrictMode>
      <EditorProvider editor={editor}>
        <BoldButton />
        <RevisionBadge />
        <EditorContent />
      </EditorProvider>
    </StrictMode>,
  );
  return editor;
}

describe("React 接入", () => {
  it("StrictMode 双挂载后只有一个可编辑区，且文档内容不丢", () => {
    const editor = renderEditor();

    expect(document.querySelectorAll('[contenteditable="true"]')).toHaveLength(1);
    expect(editor.getDocument().doc).toEqual(JSON.parse(fixtureText).doc);
    expect(screen.getByTestId("revision").textContent).toBe("0");
  });

  it("命令执行后工具栏生效态与修订号跟着更新", () => {
    renderEditor();

    fireEvent.click(screen.getByTestId("bold"));

    expect(screen.getByTestId("bold").dataset.active).toBe("true");
    expect(screen.getByTestId("revision").textContent).toBe("1");
  });
});
