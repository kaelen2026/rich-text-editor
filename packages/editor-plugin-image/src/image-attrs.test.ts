import { describe, expect, it } from "vitest";
import {
  composeCrop,
  croppedNaturalSize,
  imageLayout,
  normalizeImageAttrs,
  readCrop,
} from "./image-attrs";

describe("图片属性归一化", () => {
  it("补齐缺省值并保留合法属性", () => {
    expect(
      normalizeImageAttrs({
        src: "https://cdn.example/a.png",
        alt: "花",
        width: 800,
        height: 600,
        displayWidth: 400,
        rotate: 90,
        filter: "grayscale",
        align: "right",
        crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
      }),
    ).toEqual({
      src: "https://cdn.example/a.png",
      alt: "花",
      width: 800,
      height: 600,
      displayWidth: 400,
      rotate: 90,
      filter: "grayscale",
      align: "right",
      crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
    });
  });

  it("丢弃 data: 源与越界、非法的编辑属性", () => {
    expect(
      normalizeImageAttrs({
        src: "data:image/png;base64,AAAA",
        alt: 42,
        width: -3,
        height: 0,
        displayWidth: Number.NaN,
        rotate: 45,
        filter: "javascript:alert(1)",
        align: "middle",
        crop: { x: 0.9, y: 0, width: 0.5, height: 1 },
      }),
    ).toEqual({
      src: "",
      alt: "",
      width: null,
      height: null,
      displayWidth: null,
      rotate: 0,
      filter: "none",
      align: "none",
      // x + width 超出 1，收敛到右边界而不是整体丢弃。
      crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
    });
  });

  it("整幅裁剪等价于没有裁剪", () => {
    expect(readCrop({ x: 0, y: 0, width: 1, height: 1 })).toBeNull();
  });
});

describe("裁剪矩形合成", () => {
  it("把相对当前显示区域的选框换算回原图坐标", () => {
    expect(
      composeCrop(
        { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
        {
          x: 0.5,
          y: 0,
          width: 0.5,
          height: 0.5,
        },
      ),
    ).toEqual({ x: 0.45, y: 0.2, width: 0.25, height: 0.25 });
  });

  it("没有既有裁剪时直接采用相对选框", () => {
    expect(composeCrop(null, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 })).toEqual({
      x: 0.1,
      y: 0.1,
      width: 0.8,
      height: 0.8,
    });
  });
});

describe("裁剪后的原始尺寸", () => {
  it("按裁剪比例缩小原始像素", () => {
    expect(
      croppedNaturalSize(
        normalizeImageAttrs({
          width: 800,
          height: 600,
          crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
        }),
      ),
    ).toEqual({ width: 400, height: 300 });
  });

  it("原始尺寸未知时无法推导", () => {
    expect(
      croppedNaturalSize(normalizeImageAttrs({ src: "https://cdn.example/a.png" })),
    ).toBeNull();
  });
});

describe("图片布局样式", () => {
  it("未知尺寸的图片按容器自适应，不产生额外盒模型", () => {
    const layout = imageLayout(normalizeImageAttrs({ src: "https://cdn.example/a.png" }));
    expect(layout.wrapper).toBe("display:block;max-inline-size:100%");
    expect(layout.frame).toBe("position:relative;overflow:hidden");
    expect(layout.img).toBe("display:block;max-inline-size:100%;height:auto");
  });

  it("已知尺寸时用宽度加宽高比占位，因此仍能随容器缩小", () => {
    const layout = imageLayout(normalizeImageAttrs({ width: 800, height: 600 }));
    expect(layout.frame).toBe(
      "position:relative;overflow:hidden;width:800px;max-inline-size:100%;aspect-ratio:800/600",
    );
    expect(layout.img).toBe("display:block;width:100%;height:100%");
  });

  it("显示宽度覆盖原始宽度并按比例推导高度", () => {
    const layout = imageLayout(normalizeImageAttrs({ width: 800, height: 600, displayWidth: 400 }));
    expect(layout.frame).toContain("width:400px");
    expect(layout.frame).toContain("aspect-ratio:400/300");
  });

  it("裁剪用百分比放大并位移图片，缩放时不会错位", () => {
    const layout = imageLayout(
      normalizeImageAttrs({
        width: 800,
        height: 600,
        crop: { x: 0.25, y: 0.5, width: 0.5, height: 0.5 },
      }),
    );
    // 裁剪后的原始尺寸是 400×300，宽高比随之改变。
    expect(layout.frame).toContain("width:400px");
    expect(layout.frame).toContain("aspect-ratio:400/300");
    expect(layout.img).toBe(
      "position:absolute;left:-50%;top:-100%;width:200%;height:200%;max-inline-size:none",
    );
  });

  it("四分之一旋转交换外层占位盒，避免旋转后压住下一段", () => {
    const layout = imageLayout(normalizeImageAttrs({ width: 800, height: 600, rotate: 90 }));
    expect(layout.wrapper).toBe(
      "display:block;max-inline-size:100%;position:relative;width:600px;height:800px",
    );
    expect(layout.frame).toBe(
      "position:absolute;overflow:hidden;left:50%;top:50%;width:800px;height:600px;transform:translate(-50%,-50%) rotate(90deg)",
    );
  });

  it("180 度旋转不改变占位盒，只翻转画面", () => {
    const layout = imageLayout(normalizeImageAttrs({ width: 800, height: 600, rotate: 180 }));
    expect(layout.wrapper).toBe("display:block;max-inline-size:100%");
    expect(layout.frame).toContain("transform:rotate(180deg)");
  });

  it("滤镜只输出预设映射出的 CSS，不接受外部字符串", () => {
    expect(imageLayout(normalizeImageAttrs({ filter: "grayscale" })).img).toContain(
      "filter:grayscale(1)",
    );
    expect(imageLayout(normalizeImageAttrs({ filter: "url(evil)" })).img).not.toContain("filter:");
  });

  it("环绕与居中落在外层容器上", () => {
    expect(imageLayout(normalizeImageAttrs({ align: "left" })).wrapper).toBe(
      "float:left;margin:0 16px 8px 0;max-inline-size:100%",
    );
    expect(imageLayout(normalizeImageAttrs({ align: "center" })).wrapper).toBe(
      "display:block;width:fit-content;margin-inline:auto;max-inline-size:100%",
    );
  });
});
