// @vitest-environment jsdom
import { createEditor } from "@kaelen/editor-api";
import { buildSchema } from "@kaelen/editor-pm-adapter";
import { resolvePlugins } from "@kaelen/editor-runtime";
import { EditorState } from "prosemirror-state";
import { describe, expect, it, vi } from "vitest";
import { createImagePlugin, imageUploadKey } from "./image-plugin";

const document = {
  envelope: 1,
  schemaVersion: 1,
  plugins: {},
  doc: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "前文" }] }] },
  annotations: [],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("图片上传插件", () => {
  it("通过每笔事务 mapping 迁移上传位置", () => {
    const plugin = createImagePlugin({ uploader: { upload: vi.fn() } });
    const resolved = resolvePlugins([plugin]);
    const schema = buildSchema({ nodes: resolved.nodes, marks: resolved.marks });
    const extension = plugin.createSessionExtensions?.()[0];
    const pmPlugin = extension?.plugins(schema)[0];
    if (!pmPlugin) {
      throw new Error("图片插件未注册 PM 状态");
    }
    const image = schema.node("co_image", { src: "", alt: "x.png", width: null, height: null });
    const text = schema.node("paragraph", undefined, schema.text("后文"));
    let state = EditorState.create({
      schema,
      doc: schema.node("doc", undefined, [image, text]),
      plugins: [pmPlugin],
    });
    state = state.apply(
      state.tr.setMeta(imageUploadKey, {
        kind: "start",
        record: { uploadId: "upload-test", pos: 0, status: "uploading" },
      }),
    );
    state = state.apply(
      state.tr.insert(0, schema.node("paragraph", undefined, schema.text("前置大段"))),
    );

    expect(imageUploadKey.getState(state)?.uploads).toEqual([
      { uploadId: "upload-test", pos: 6, status: "uploading" },
    ]);
  });

  it("映射上传目标并以不入历史的事务回填", async () => {
    const upload = deferred<{ url: string; alt?: string }>();
    const uploader = { upload: vi.fn(() => upload.promise) };
    const editor = createEditor({ plugins: [createImagePlugin({ uploader })] });
    editor.loadDocument(document);

    const file = new File(["image"], "flower.png", { type: "image/png" });
    expect(editor.execute("image.insert", { file })).toEqual({ ok: true });
    expect(editor.getDocument().doc).toEqual({
      type: "doc",
      content: [
        { type: "co_image", attrs: { src: "", alt: "flower.png", width: null, height: null } },
        { type: "paragraph", content: [{ type: "text", text: "前文" }] },
      ],
    });

    upload.resolve({ url: "https://cdn.example/flower.png", alt: "花" });
    await Promise.resolve();
    await Promise.resolve();

    expect(editor.getDocument().doc.content?.find((node) => node.type === "co_image")).toEqual({
      type: "co_image",
      attrs: { src: "https://cdn.example/flower.png", alt: "花", width: null, height: null },
    });
    expect(editor.undo().ok).toBe(true);
    expect(editor.getDocument().doc.content?.some((node) => node.type === "co_image")).toBe(false);
  });

  it("保留工具栏提供的替代文本，直到上传器返回更具体的文本", () => {
    const editor = createEditor({
      plugins: [
        createImagePlugin({
          uploader: { upload: vi.fn((): Promise<{ url: string }> => new Promise(() => {})) },
        }),
      ],
    });
    editor.loadDocument(document);

    editor.execute("image.insert", {
      file: new File(["image"], "diagram.png", { type: "image/png" }),
      alt: "发布流程图",
    });

    expect(
      editor.getDocument().doc.content?.find((node) => node.type === "co_image"),
    ).toMatchObject({
      attrs: { alt: "发布流程图" },
    });
  });

  it("删除上传目标后丢弃完成的资产，并在卸载时取消上传", async () => {
    const upload = deferred<{ url: string }>();
    const discard = vi.fn();
    const uploader = { upload: vi.fn(() => upload.promise), discard };
    const editor = createEditor({ plugins: [createImagePlugin({ uploader })] });
    editor.loadDocument(document);
    editor.execute("image.insert", { file: new File(["image"], "x.png", { type: "image/png" }) });
    editor.execute("history.undo");

    upload.resolve({ url: "https://cdn.example/x.png" });
    await Promise.resolve();
    await Promise.resolve();
    expect(discard).toHaveBeenCalledWith({ url: "https://cdn.example/x.png" });

    const hanging = deferred<{ url: string }>();
    let cancellation: AbortSignal | undefined;
    const second = createEditor({
      plugins: [
        createImagePlugin({
          uploader: {
            upload: vi.fn((_file, options) => {
              cancellation = options.signal;
              return hanging.promise;
            }),
          },
        }),
      ],
    });
    second.loadDocument(document);
    second.execute("image.insert", { file: new File(["image"], "y.png", { type: "image/png" }) });
    const host = globalThis.document.createElement("div");
    second.mount(host);
    second.unmount();
    expect(cancellation?.aborted).toBe(true);
  });

  it("文档和内部复制载荷都不包含 uploadId", () => {
    const editor = createEditor({
      plugins: [
        createImagePlugin({
          uploader: { upload: vi.fn((): Promise<{ url: string }> => new Promise(() => {})) },
        }),
      ],
    });
    editor.loadDocument(document);
    editor.execute("image.insert", {
      file: new File(["image"], "copy.png", { type: "image/png" }),
    });

    expect(JSON.stringify(editor.getDocument())).not.toContain("uploadId");
  });
});
