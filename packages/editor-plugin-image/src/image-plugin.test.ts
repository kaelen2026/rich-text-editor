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

/** 二次编辑属性的默认值：老文档没有这些键，装载后由 Schema 补齐。 */
const EDIT_DEFAULTS = {
  displayWidth: null,
  crop: null,
  rotate: 0,
  filter: "none",
  align: "none",
};

/** 首个块就是图片，因此它的文档位置恒为 0，测试可以直接用 pos 定位。 */
const documentWithImage = {
  envelope: 1,
  schemaVersion: 1,
  plugins: { image: 2 },
  doc: {
    type: "doc",
    content: [
      { type: "co_image", attrs: { src: "https://cdn.example/a.png", alt: "花" } },
      { type: "paragraph", content: [{ type: "text", text: "后文" }] },
    ],
  },
  annotations: [],
};

function editorWithImage(
  attrs: Record<string, unknown> = { width: 800, height: 600 },
  uploader: { upload: (...args: never[]) => unknown } = { upload: vi.fn() },
) {
  const editor = createEditor({
    plugins: [createImagePlugin({ uploader: uploader as never })],
  });
  editor.loadDocument({
    ...documentWithImage,
    doc: {
      type: "doc",
      content: [
        {
          type: "co_image",
          attrs: { ...documentWithImage.doc.content[0]?.attrs, ...attrs },
        },
        { type: "paragraph", content: [{ type: "text", text: "后文" }] },
      ],
    },
  });
  return editor;
}

function imageAttrs(editor: ReturnType<typeof createEditor>): Record<string, unknown> {
  const image = editor.getDocument().doc.content?.find((node) => node.type === "co_image");
  if (!image?.attrs) {
    throw new Error("文档里没有图片节点");
  }
  return image.attrs;
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
        {
          type: "co_image",
          attrs: { ...EDIT_DEFAULTS, src: "", alt: "flower.png", width: null, height: null },
        },
        { type: "paragraph", content: [{ type: "text", text: "前文" }] },
      ],
    });

    upload.resolve({ url: "https://cdn.example/flower.png", alt: "花" });
    await Promise.resolve();
    await Promise.resolve();

    expect(editor.getDocument().doc.content?.find((node) => node.type === "co_image")).toEqual({
      type: "co_image",
      attrs: {
        ...EDIT_DEFAULTS,
        src: "https://cdn.example/flower.png",
        alt: "花",
        width: null,
        height: null,
      },
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

  it("只持久化远端转存服务返回的资产 URL", () => {
    const editor = createEditor({
      plugins: [createImagePlugin({ uploader: { upload: vi.fn() } })],
    });
    editor.loadDocument(document);

    expect(
      editor.execute("image.insertAsset", {
        asset: { url: "https://assets.example/relocated.png", alt: "已转存图片" },
      }),
    ).toEqual({ ok: true });
    expect(editor.getDocument().doc.content?.[0]).toEqual({
      type: "co_image",
      attrs: {
        ...EDIT_DEFAULTS,
        src: "https://assets.example/relocated.png",
        alt: "已转存图片",
        width: null,
        height: null,
      },
    });
  });
});

describe("图片二次编辑", () => {
  it("老文档缺少二次编辑属性时按默认值补齐，保存后不丢字段", () => {
    expect(imageAttrs(editorWithImage())).toEqual({
      ...EDIT_DEFAULTS,
      src: "https://cdn.example/a.png",
      alt: "花",
      width: 800,
      height: 600,
    });
  });

  it("改替代文本可撤销，且不影响其他属性", () => {
    const editor = editorWithImage();

    expect(editor.execute("image.setAlt", { pos: 0, alt: "花园里的月季" })).toEqual({ ok: true });
    expect(imageAttrs(editor).alt).toBe("花园里的月季");

    expect(editor.undo().ok).toBe(true);
    expect(imageAttrs(editor).alt).toBe("花");
  });

  it("缩放只改展示宽度，原始尺寸保留下来供恢复", () => {
    const editor = editorWithImage();

    expect(editor.execute("image.resize", { pos: 0, width: 400 })).toEqual({ ok: true });
    expect(imageAttrs(editor)).toMatchObject({ displayWidth: 400, width: 800, height: 600 });

    expect(editor.execute("image.resize", { pos: 0, width: null })).toEqual({ ok: true });
    expect(imageAttrs(editor).displayWidth).toBeNull();
  });

  it("对齐与环绕写进属性，工具栏据此高亮当前项", () => {
    const editor = editorWithImage();

    expect(editor.execute("image.setAlign", { pos: 0, align: "left" })).toEqual({ ok: true });
    expect(imageAttrs(editor).align).toBe("left");
    expect(editor.queryCommand("image.setAlign", { pos: 0, align: "left" }).active).toBe(true);
    expect(editor.queryCommand("image.setAlign", { pos: 0, align: "right" }).active).toBe(false);
    expect(editor.execute("image.setAlign", { pos: 0, align: "斜着放" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
  });

  it("旋转按四分之一圈累加，也能直接归零", () => {
    const editor = editorWithImage();

    editor.execute("image.rotate", { pos: 0, turn: 1 });
    expect(imageAttrs(editor).rotate).toBe(90);
    editor.execute("image.rotate", { pos: 0, turn: 1 });
    editor.execute("image.rotate", { pos: 0, turn: 1 });
    expect(imageAttrs(editor).rotate).toBe(270);
    editor.execute("image.rotate", { pos: 0, turn: 1 });
    expect(imageAttrs(editor).rotate).toBe(0);
    editor.execute("image.rotate", { pos: 0, turn: -1 });
    expect(imageAttrs(editor).rotate).toBe(270);
    editor.execute("image.rotate", { pos: 0, rotate: 0 });
    expect(imageAttrs(editor).rotate).toBe(0);
  });

  it("滤镜只接受预设名", () => {
    const editor = editorWithImage();

    expect(editor.execute("image.setFilter", { pos: 0, filter: "grayscale" })).toEqual({
      ok: true,
    });
    expect(imageAttrs(editor).filter).toBe("grayscale");
    expect(editor.execute("image.setFilter", { pos: 0, filter: "url(evil.css)" })).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(imageAttrs(editor).filter).toBe("grayscale");
  });

  it("再次裁剪相对当前画面，属性里合成回原图坐标", () => {
    const editor = editorWithImage();

    editor.execute("image.crop", { pos: 0, crop: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 } });
    expect(imageAttrs(editor).crop).toEqual({ x: 0.2, y: 0.2, width: 0.5, height: 0.5 });

    editor.execute("image.crop", { pos: 0, crop: { x: 0.5, y: 0, width: 0.5, height: 0.5 } });
    expect(imageAttrs(editor).crop).toEqual({ x: 0.45, y: 0.2, width: 0.25, height: 0.25 });

    expect(editor.execute("image.crop", { pos: 0, crop: null })).toEqual({ ok: true });
    expect(imageAttrs(editor).crop).toBeNull();
  });

  it("原始尺寸未知时裁剪与旋转不可用，其余编辑照常", () => {
    const editor = editorWithImage({ width: null, height: null });

    expect(editor.queryCommand("image.crop", { pos: 0 }).enabled).toBe(false);
    expect(editor.queryCommand("image.rotate", { pos: 0, turn: 1 }).enabled).toBe(false);
    expect(editor.queryCommand("image.setAlt", { pos: 0, alt: "x" }).enabled).toBe(true);
    expect(
      editor.execute("image.crop", { pos: 0, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } }),
    ).toMatchObject({ ok: false, reason: "disabled" });
  });

  it("目标不是图片时命令失败而不是误改别的节点", () => {
    const editor = editorWithImage();

    expect(editor.execute("image.setAlt", { pos: 1, alt: "x" })).toMatchObject({
      ok: false,
      reason: "disabled",
    });
    // 没给位置、当前也没有整节点选中图片时，命令不去猜"大概是哪一张"。
    const withoutImage = createEditor({
      plugins: [createImagePlugin({ uploader: { upload: vi.fn() } })],
    });
    withoutImage.loadDocument(document);
    expect(withoutImage.execute("image.setAlt", { alt: "x" })).toMatchObject({
      ok: false,
      reason: "disabled",
    });
  });

  it("image.selected 交回归一化属性，宿主据此渲染浮层工具条", () => {
    const editor = editorWithImage({ width: 800, height: 600, displayWidth: 400 });

    expect(editor.execute("image.selected", { pos: 0 })).toEqual({
      ok: true,
      detail: {
        pos: 0,
        attrs: {
          ...EDIT_DEFAULTS,
          src: "https://cdn.example/a.png",
          alt: "花",
          width: 800,
          height: 600,
          displayWidth: 400,
        },
        naturalSize: { width: 800, height: 600 },
        displaySize: { width: 400, height: 300 },
      },
    });
    expect(editor.execute("image.selected", { pos: 1 })).toMatchObject({ ok: false });
  });

  it("只读态仍可读取图片状态，但不能改", () => {
    const editor = editorWithImage();
    editor.setMode("readonly");

    expect(editor.execute("image.selected", { pos: 0 }).ok).toBe(true);
    expect(editor.execute("image.setAlt", { pos: 0, alt: "x" })).toMatchObject({ ok: false });
  });

  it("裁剪、旋转、滤镜与环绕都渲染进 HTML，服务端与浏览器同一份输出", () => {
    const editor = editorWithImage();
    editor.execute("image.crop", { pos: 0, crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 } });
    editor.execute("image.setFilter", { pos: 0, filter: "grayscale" });
    editor.execute("image.setAlign", { pos: 0, align: "left" });

    const html = editor.getHTML();
    expect(html).toContain('data-align="left"');
    expect(html).toContain("float:left");
    expect(html).toContain("aspect-ratio:400/300");
    expect(html).toContain("width:200%");
    expect(html).toContain("filter:grayscale(1)");
    expect(html).toContain('alt="花"');
  });

  it("属性被外部改坏时渲染仍然收敛，不会把脏值抄进 HTML", () => {
    const editor = editorWithImage({
      width: 800,
      height: 600,
      filter: "url(evil.css)",
      align: "expression(alert(1))",
      rotate: 45,
      crop: { x: 2, y: 2, width: 9, height: 9 },
    });

    const html = editor.getHTML();
    expect(html).not.toContain("evil.css");
    expect(html).not.toContain("expression");
    expect(html).not.toContain("rotate(45deg)");
  });
});

describe("图片替换", () => {
  it("原位替换：上传中提示替换、成功后换资产并清掉旧裁剪", async () => {
    const upload = deferred<{ url: string; width: number; height: number }>();
    const uploader = { upload: vi.fn(() => upload.promise) };
    const editor = editorWithImage({ width: 800, height: 600 }, uploader);
    editor.execute("image.crop", { pos: 0, crop: { x: 0, y: 0, width: 0.5, height: 0.5 } });

    const file = new File(["next"], "next.png", { type: "image/png" });
    expect(editor.execute("image.replace", { pos: 0, file })).toEqual({ ok: true });
    // 替换期间原图仍在，用户不会看到内容闪空。
    expect(imageAttrs(editor).src).toBe("https://cdn.example/a.png");

    upload.resolve({ url: "https://cdn.example/next.png", width: 400, height: 400 });
    await Promise.resolve();
    await Promise.resolve();

    expect(imageAttrs(editor)).toMatchObject({
      src: "https://cdn.example/next.png",
      width: 400,
      height: 400,
      crop: null,
      alt: "花",
    });
  });

  it("替换失败时保留原图，并且可以重试", async () => {
    const first = deferred<{ url: string }>();
    const second = deferred<{ url: string }>();
    const upload = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const editor = editorWithImage({ width: 800, height: 600 }, { upload });

    editor.execute("image.replace", {
      pos: 0,
      file: new File(["next"], "next.png", { type: "image/png" }),
    });
    first.reject(new Error("网络断了"));
    await Promise.resolve();
    await Promise.resolve();

    expect(imageAttrs(editor).src).toBe("https://cdn.example/a.png");

    expect(editor.execute("image.retry", { pos: 0 })).toEqual({ ok: true });
    second.resolve({ url: "https://cdn.example/next.png" });
    await Promise.resolve();
    await Promise.resolve();

    expect(imageAttrs(editor).src).toBe("https://cdn.example/next.png");
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it("替换目标在上传完成前消失时丢弃结果", async () => {
    const upload = deferred<{ url: string }>();
    const discard = vi.fn();
    const editor = editorWithImage({ width: 800, height: 600 }, {
      upload: vi.fn(() => upload.promise),
      discard,
    } as never);

    editor.execute("image.replace", {
      pos: 0,
      file: new File(["next"], "next.png", { type: "image/png" }),
    });
    editor.execute("image.remove", { pos: 0 });

    upload.resolve({ url: "https://cdn.example/next.png" });
    await Promise.resolve();
    await Promise.resolve();

    expect(discard).toHaveBeenCalledWith({ url: "https://cdn.example/next.png" });
  });
});
