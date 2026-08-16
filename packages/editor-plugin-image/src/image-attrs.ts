/**
 * `co_image` 的属性模型与渲染推导。
 *
 * 二次编辑一律是**非破坏性**的：裁剪、旋转、滤镜、缩放都只写属性，不重新上传，
 * 也不把像素烘进新资产。用户因此可以反复回到任何一步继续调整，文档里也永远
 * 只有一个资产地址（方案 §11.3：`data:` 不入文档）。
 *
 * 本模块对 DOM、ProseMirror 都零依赖：`toDOM` 与服务端渲染器共用它，
 * 因此浏览器与 Node 产出的 HTML 必须逐字节一致。
 */

/** 滤镜白名单。文档里存的是预设名，渲染时才映射成 CSS，外部字符串进不来。 */
export const IMAGE_FILTERS = {
  none: "",
  grayscale: "grayscale(1)",
  sepia: "sepia(0.7)",
  vivid: "saturate(1.4) contrast(1.05)",
  soft: "saturate(0.75) brightness(1.06)",
  cool: "hue-rotate(-12deg) saturate(1.15)",
  warm: "sepia(0.35) saturate(1.2)",
} as const;

export type ImageFilter = keyof typeof IMAGE_FILTERS;
export type ImageAlign = "none" | "left" | "center" | "right";
export type ImageRotation = 0 | 90 | 180 | 270;

/** 裁剪矩形，以原图为单位的比例坐标（0–1）。与像素尺寸解耦，换分辨率也不失真。 */
export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageAttrs {
  src: string;
  alt: string;
  /** 资产的原始像素宽高。裁剪与缩放都不改它，"恢复原始尺寸"因此永远可达。 */
  width: number | null;
  height: number | null;
  /** 展示宽度（CSS 像素）。null 表示按裁剪后的原始宽度显示。 */
  displayWidth: number | null;
  crop: ImageCrop | null;
  rotate: ImageRotation;
  filter: ImageFilter;
  align: ImageAlign;
}

export interface ImageLayout {
  wrapper: string;
  frame: string;
  img: string;
}

/** 裁剪的最小边长，避免除以接近 0 的比例把百分比放大到失控。 */
const MIN_CROP = 0.02;
const ROTATIONS: readonly ImageRotation[] = [0, 90, 180, 270];
const ALIGNMENTS: readonly ImageAlign[] = ["none", "left", "center", "right"];

/**
 * 把任意来源的属性收敛成可渲染的模型。
 *
 * 文档可能来自 localStorage、服务端或导入，属性未必可信：越界的裁剪、伪造的
 * 滤镜串、`data:` 源都在这里被挡下，命令与渲染两侧共用同一份判断。
 */
export function normalizeImageAttrs(attrs: Record<string, unknown> = {}): ImageAttrs {
  return {
    src: readSource(attrs.src),
    alt: typeof attrs.alt === "string" ? attrs.alt : "",
    width: readDimension(attrs.width),
    height: readDimension(attrs.height),
    displayWidth: readDimension(attrs.displayWidth),
    crop: readCrop(attrs.crop),
    rotate: ROTATIONS.find((value) => value === attrs.rotate) ?? 0,
    filter: isFilter(attrs.filter) ? attrs.filter : "none",
    align: ALIGNMENTS.find((value) => value === attrs.align) ?? "none",
  };
}

/** 校验并收敛裁剪矩形；整幅裁剪归一为"没有裁剪"，属性因此不会记录空操作。 */
export function readCrop(value: unknown): ImageCrop | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { x, y, width, height } = value as Record<string, unknown>;
  if (
    !isFiniteNumber(x) ||
    !isFiniteNumber(y) ||
    !isFiniteNumber(width) ||
    !isFiniteNumber(height)
  ) {
    return null;
  }
  const size = {
    width: clamp(width, MIN_CROP, 1),
    height: clamp(height, MIN_CROP, 1),
  };
  const crop = {
    x: clamp(x, 0, 1 - size.width),
    y: clamp(y, 0, 1 - size.height),
    width: size.width,
    height: size.height,
  };
  return isFullFrame(crop) ? null : crop;
}

/**
 * 把"相对当前显示区域"的选框换算回原图坐标。
 *
 * 裁剪 UI 只知道用户在当前画面上框了哪一块，而属性必须以原图为准；二次裁剪
 * 因此是两个矩形的合成，而不是覆盖——否则第二次裁剪会把第一次的结果算错。
 */
export function composeCrop(current: ImageCrop | null, relative: ImageCrop): ImageCrop | null {
  const target = readCrop(relative);
  if (!target) {
    return current;
  }
  const base = current ?? { x: 0, y: 0, width: 1, height: 1 };
  return readCrop({
    x: base.x + target.x * base.width,
    y: base.y + target.y * base.height,
    width: base.width * target.width,
    height: base.height * target.height,
  });
}

/**
 * 把用户在**旋转后的画面**上框出的矩形转回图片自身的坐标。
 *
 * 裁剪 UI 只认屏幕上看到的那一块，而裁剪属性说的是原图的哪一块；图片转过之后
 * 两者的坐标轴不再重合，少了这一步，转过 90 度的图会被裁到完全不相干的位置。
 */
export function unrotateCrop(rect: ImageCrop, rotate: ImageRotation): ImageCrop {
  const { x, y, width, height } = rect;
  if (rotate === 90) {
    return { x: y, y: 1 - x - width, width: height, height: width };
  }
  if (rotate === 180) {
    return { x: 1 - x - width, y: 1 - y - height, width, height };
  }
  if (rotate === 270) {
    return { x: 1 - y - height, y: x, width: height, height: width };
  }
  return rect;
}

/** 裁剪后的原始尺寸，也就是"恢复原始尺寸"要回到的那个宽高。 */
export function croppedNaturalSize(attrs: ImageAttrs): { width: number; height: number } | null {
  if (attrs.width === null || attrs.height === null) {
    return null;
  }
  const crop = attrs.crop;
  return {
    width: Math.round(attrs.width * (crop?.width ?? 1)),
    height: Math.round(attrs.height * (crop?.height ?? 1)),
  };
}

/** 当前展示盒的宽高（未旋转前）。原始尺寸未知时无法推导，返回 null。 */
export function displaySize(attrs: ImageAttrs): { width: number; height: number } | null {
  const natural = croppedNaturalSize(attrs);
  if (!natural) {
    return null;
  }
  const width = attrs.displayWidth ?? natural.width;
  return { width, height: Math.max(1, Math.round((width * natural.height) / natural.width)) };
}

/**
 * 推导三层结构的内联样式：外层负责对齐/环绕与旋转后的占位，中层是裁剪窗口，
 * 内层是被放大位移的图片。
 *
 * 用内联样式而不是类名，是为了让 `getHTML()` 导出的内容脱离本项目样式表也保真：
 * 服务端渲染、邮件、外部预览拿到的都是同一份自足 HTML。
 */
export function imageLayout(attrs: ImageAttrs): ImageLayout {
  const box = displaySize(attrs);
  const quarter = attrs.rotate === 90 || attrs.rotate === 270;
  return {
    wrapper: join([...alignDeclarations(attrs.align), ...rotationBox(box, quarter)]),
    frame: join(frameDeclarations(attrs, box, quarter)),
    img: join([...imageDeclarations(attrs, box !== null), ...filterDeclaration(attrs.filter)]),
  };
}

function alignDeclarations(align: ImageAlign): string[] {
  const placement: Record<ImageAlign, string[]> = {
    none: ["display:block"],
    center: ["display:block", "width:fit-content", "margin-inline:auto"],
    left: ["float:left", "margin:0 16px 8px 0"],
    right: ["float:right", "margin:0 0 8px 16px"],
  };
  return [...placement[align], "max-inline-size:100%"];
}

/** 旋转不参与布局，四分之一转必须由外层显式换过来的占位盒撑开。 */
function rotationBox(box: { width: number; height: number } | null, quarter: boolean): string[] {
  return quarter && box
    ? ["position:relative", `width:${box.height}px`, `height:${box.width}px`]
    : [];
}

function frameDeclarations(
  attrs: ImageAttrs,
  box: { width: number; height: number } | null,
  quarter: boolean,
): string[] {
  if (quarter && box) {
    return [
      "position:absolute",
      "overflow:hidden",
      "left:50%",
      "top:50%",
      `width:${box.width}px`,
      `height:${box.height}px`,
      `transform:translate(-50%,-50%) rotate(${attrs.rotate}deg)`,
    ];
  }
  return [
    "position:relative",
    "overflow:hidden",
    // 宽度加宽高比：容器变窄时整块等比缩小，裁剪用的百分比因此依然成立。
    ...(box
      ? [`width:${box.width}px`, "max-inline-size:100%", `aspect-ratio:${box.width}/${box.height}`]
      : []),
    ...(attrs.rotate === 180 ? ["transform:rotate(180deg)"] : []),
  ];
}

function imageDeclarations(attrs: ImageAttrs, sized: boolean): string[] {
  const crop = attrs.crop;
  if (crop) {
    return [
      "position:absolute",
      `left:${percent((-100 * crop.x) / crop.width)}`,
      `top:${percent((-100 * crop.y) / crop.height)}`,
      `width:${percent(100 / crop.width)}`,
      `height:${percent(100 / crop.height)}`,
      "max-inline-size:none",
    ];
  }
  return sized
    ? ["display:block", "width:100%", "height:100%"]
    : ["display:block", "max-inline-size:100%", "height:auto"];
}

function filterDeclaration(filter: ImageFilter): string[] {
  const css = IMAGE_FILTERS[filter];
  return css ? [`filter:${css}`] : [];
}

function isFilter(value: unknown): value is ImageFilter {
  return typeof value === "string" && value in IMAGE_FILTERS;
}

function isFullFrame(crop: ImageCrop): boolean {
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function readDimension(value: unknown): number | null {
  return isFiniteNumber(value) && value > 0 ? Math.round(value) : null;
}

/** `data:` 只可能作为瞬时本地预览，永远不能进入可保存文档。 */
function readSource(value: unknown): string {
  return typeof value === "string" && !value.startsWith("data:") ? value : "";
}

/** 百分比保留四位小数：够精确，又不会让同一份文档在不同环境渲染出不同字符串。 */
function percent(value: number): string {
  return `${Number(value.toFixed(4))}%`;
}

function join(declarations: string[]): string {
  return declarations.join(";");
}
