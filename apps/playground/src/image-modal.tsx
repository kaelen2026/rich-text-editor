import {
  IMAGE_FILTERS,
  type ImageAlign,
  type ImageAttrs,
  type ImageCrop,
  type ImageFilter,
  type ImageRotation,
  imageLayout,
  unrotateCrop,
} from "@kaelen/editor-plugin-image";
import { useEditor } from "@kaelen/editor-react";
import {
  Check,
  Crop,
  Replace,
  RotateCcw,
  RotateCw,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  X,
} from "lucide-react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";

/** `image.selected` 交回的东西：位置、归一化属性和推导出的尺寸。 */
export interface SelectedImage {
  pos: number;
  attrs: ImageAttrs;
  naturalSize: { width: number; height: number } | null;
  displaySize: { width: number; height: number } | null;
}

/** 模态里改动的那几项。src 与原始尺寸不在其中：换图是另一件事。 */
type ImageDraft = Pick<ImageAttrs, "alt" | "displayWidth" | "align" | "rotate" | "filter" | "crop">;

const STAGE = { width: 520, height: 380 };
const MIN_CROP = 0.05;

const SIZE_PRESETS: readonly { label: string; width: number | null }[] = [
  { label: "小", width: 320 },
  { label: "中", width: 480 },
  { label: "大", width: 720 },
  { label: "原始", width: null },
];

const ALIGN_PRESETS: readonly { label: string; align: ImageAlign; icon: typeof TextAlignStart }[] =
  [
    { label: "独占一行", align: "none", icon: TextAlignJustify },
    { label: "左侧环绕", align: "left", icon: TextAlignStart },
    { label: "居中", align: "center", icon: TextAlignCenter },
    { label: "右侧环绕", align: "right", icon: TextAlignEnd },
  ];

const FILTER_LABELS: Record<ImageFilter, string> = {
  none: "原图",
  grayscale: "黑白",
  sepia: "怀旧",
  vivid: "鲜艳",
  soft: "柔和",
  cool: "冷调",
  warm: "暖调",
};

/**
 * 双击图片打开的编辑模态。
 *
 * 改动先落在草稿上，预览用的是**文档渲染同一套推导**（`imageLayout`），
 * 所见即所得不靠另写一份样式；点"应用"才通过 `image.update` 一次写入，
 * 因此撤销一步就回到打开模态之前，中途反悔直接关掉即可。
 */
export function ImageModal({
  selected,
  onClose,
}: {
  selected: SelectedImage;
  onClose: () => void;
}) {
  const editor = useEditor();
  const attrs = selected.attrs;
  const [draft, setDraft] = useState<ImageDraft>(() => ({
    alt: attrs.alt,
    displayWidth: attrs.displayWidth,
    align: attrs.align,
    rotate: attrs.rotate,
    filter: attrs.filter,
    crop: attrs.crop,
  }));
  const replaceInput = useRef<HTMLInputElement>(null);
  const canTransform = selected.naturalSize !== null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const change = (patch: Partial<ImageDraft>) => setDraft((current) => ({ ...current, ...patch }));

  /** 只提交真正改过的项：没动过的属性不进事务，patch 流里也就看不到噪声。 */
  const apply = () => {
    const changed = Object.fromEntries(
      Object.entries(draft).filter(([key, value]) => {
        const before = attrs[key as keyof ImageDraft];
        return JSON.stringify(before) !== JSON.stringify(value);
      }),
    );
    if (Object.keys(changed).length > 0) {
      editor.execute("image.update", { pos: selected.pos, ...changed });
    }
    return Object.keys(changed).length > 0;
  };

  return (
    <div className="image-modal-backdrop" onPointerDown={onClose}>
      <div
        aria-label="编辑图片"
        aria-modal="true"
        className="image-modal"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="image-modal-header">
          <h2>编辑图片</h2>
          <button aria-label="关闭" className="image-modal-close" onClick={onClose} type="button">
            <X aria-hidden="true" size={16} strokeWidth={1.75} />
          </button>
        </header>

        <div className="image-modal-body">
          <CropStage
            attrs={attrs}
            croppable={canTransform}
            draft={draft}
            onCrop={(crop) => change({ crop })}
          />

          <div className="image-modal-panel">
            <Field label="替代文本">
              <input
                aria-label="替代文本"
                className="image-modal-input"
                onChange={(event) => change({ alt: event.target.value })}
                placeholder="描述这张图片"
                type="text"
                value={draft.alt}
              />
            </Field>

            <Field label="尺寸">
              <div className="image-modal-segments">
                {SIZE_PRESETS.map((preset) => (
                  <button
                    className="image-modal-segment"
                    data-active={draft.displayWidth === preset.width}
                    disabled={!canTransform}
                    key={preset.label}
                    onClick={() => change({ displayWidth: preset.width })}
                    type="button"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="对齐与环绕">
              <div className="image-modal-segments">
                {ALIGN_PRESETS.map(({ align, icon: Icon, label }) => (
                  <button
                    aria-label={label}
                    className="image-modal-segment"
                    data-active={draft.align === align}
                    key={align}
                    onClick={() => change({ align })}
                    title={label}
                    type="button"
                  >
                    <Icon aria-hidden="true" size={15} strokeWidth={1.75} />
                  </button>
                ))}
              </div>
            </Field>

            <Field
              hint={canTransform ? undefined : "这张图片缺少原始尺寸，旋转与裁剪不可用"}
              label="旋转"
            >
              <div className="image-modal-segments">
                <button
                  className="image-modal-segment"
                  disabled={!canTransform}
                  onClick={() => change({ rotate: turn(draft.rotate, -1) })}
                  type="button"
                >
                  <RotateCcw aria-hidden="true" size={15} strokeWidth={1.75} />
                  向左
                </button>
                <button
                  className="image-modal-segment"
                  disabled={!canTransform}
                  onClick={() => change({ rotate: turn(draft.rotate, 1) })}
                  type="button"
                >
                  <RotateCw aria-hidden="true" size={15} strokeWidth={1.75} />
                  向右
                </button>
              </div>
            </Field>

            <Field label="滤镜">
              <div className="image-modal-filters">
                {(Object.keys(IMAGE_FILTERS) as ImageFilter[]).map((filter) => (
                  <button
                    className="image-modal-filter"
                    data-active={draft.filter === filter}
                    key={filter}
                    onClick={() => change({ filter })}
                    type="button"
                  >
                    <img
                      alt=""
                      src={attrs.src}
                      style={{ filter: IMAGE_FILTERS[filter] || "none" }}
                    />
                    <span>{FILTER_LABELS[filter]}</span>
                  </button>
                ))}
              </div>
            </Field>
          </div>
        </div>

        <footer className="image-modal-footer">
          <button className="action" onClick={() => replaceInput.current?.click()} type="button">
            <Replace aria-hidden="true" size={14} strokeWidth={1.75} />
            替换图片
          </button>
          <span className="image-modal-spacer" />
          <button className="action" onClick={onClose} type="button">
            取消
          </button>
          <button
            className="action action-primary"
            onClick={() => {
              apply();
              onClose();
            }}
            type="button"
          >
            <Check aria-hidden="true" size={14} strokeWidth={2} />
            应用
          </button>
        </footer>

        <input
          accept="image/*"
          hidden
          ref={replaceInput}
          type="file"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) {
              return;
            }
            // 换图是另一件事，先把已经改好的样子落下来，再开始上传并退出模态。
            apply();
            editor.execute("image.replace", { pos: selected.pos, file });
            onClose();
          }}
        />
      </div>
    </div>
  );
}

function Field({ children, hint, label }: { children: ReactNode; hint?: string; label: string }) {
  return (
    <div className="image-modal-field">
      <span className="image-modal-label">{label}</span>
      {children}
      {hint ? <span className="image-modal-hint">{hint}</span> : null}
    </div>
  );
}

/**
 * 预览与裁剪台。
 *
 * 台上摆的始终是**整幅原图**（按草稿的旋转与滤镜显示），选框标出要保留的那块：
 * 二次裁剪因此能看到被裁掉的部分，可以把框拉回去，而不是只能在已裁的结果上再裁。
 */
function CropStage({
  attrs,
  croppable,
  draft,
  onCrop,
}: {
  attrs: ImageAttrs;
  croppable: boolean;
  draft: ImageDraft;
  onCrop: (crop: ImageCrop | null) => void;
}) {
  const drag = useRef<{ mode: DragMode; x: number; y: number; origin: ImageCrop } | null>(null);
  const surface = useRef<HTMLDivElement>(null);

  // 预览直接复用文档渲染的推导：所见即所得不靠再写一份样式。
  const preview = imageLayout({
    ...attrs,
    ...draft,
    align: "none",
    crop: null,
    displayWidth: fitWidth(attrs, draft.rotate),
  });
  const box = toDisplayCrop(draft.crop, draft.rotate);

  const begin = (event: ReactPointerEvent<HTMLElement>, mode: DragMode) => {
    if (!croppable) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const rect = surface.current?.getBoundingClientRect();
    const origin =
      mode === "draw" && rect
        ? {
            x: (event.clientX - rect.left) / rect.width,
            y: (event.clientY - rect.top) / rect.height,
            width: MIN_CROP,
            height: MIN_CROP,
          }
        : box;
    drag.current = { mode, x: event.clientX, y: event.clientY, origin };
  };

  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const current = drag.current;
    const rect = surface.current?.getBoundingClientRect();
    if (!current || !rect) {
      return;
    }
    const next = resize(
      current.mode,
      current.origin,
      (event.clientX - current.x) / rect.width,
      (event.clientY - current.y) / rect.height,
    );
    onCrop(unrotateCrop(next, draft.rotate));
  };

  const end = () => {
    drag.current = null;
  };

  return (
    <div className="image-modal-stage">
      <StyledBox className="image-modal-preview" css={preview.wrapper}>
        <StyledBox className="image-modal-frame" css={preview.frame}>
          <img alt="" src={attrs.src} style={cssObject(preview.img)} />
        </StyledBox>
        {/*
         * 选框铺在**外层**而不是画面上：四分之一旋转时画面自己是转过的，
         * 选框跟着转就会和用户的手势对不上——外层占的正是转完之后的那个盒子。
         */}
        {croppable ? (
          <div
            className="image-crop-surface"
            onPointerDown={(event) => begin(event, "draw")}
            onPointerMove={move}
            onPointerUp={end}
            ref={surface}
          >
            <div
              className="image-crop-frame"
              onPointerDown={(event) => begin(event, "move")}
              onPointerMove={move}
              onPointerUp={end}
              style={{
                left: `${box.x * 100}%`,
                top: `${box.y * 100}%`,
                width: `${box.width * 100}%`,
                height: `${box.height * 100}%`,
              }}
            >
              {(["nw", "ne", "sw", "se"] as const).map((corner) => (
                <span
                  className={`image-crop-handle image-crop-${corner}`}
                  key={corner}
                  onPointerDown={(event) => begin(event, corner)}
                  onPointerMove={move}
                  onPointerUp={end}
                />
              ))}
            </div>
          </div>
        ) : null}
      </StyledBox>
      <p className="image-modal-caption">
        <Crop aria-hidden="true" size={13} strokeWidth={1.75} />
        {croppable ? "在图上拖出要保留的部分" : "这张图片缺少原始尺寸，无法裁剪"}
        {draft.crop ? (
          <button className="image-modal-link" onClick={() => onCrop(null)} type="button">
            还原整幅
          </button>
        ) : null}
      </p>
    </div>
  );
}

/**
 * 把渲染推导出的 CSS 字符串挂到元素上。
 *
 * 走 `cssText` 而不是把字符串拆成 React 的 style 对象：拆解本身就是一次
 * 再实现，早晚会和渲染器对不上，而预览的全部意义就是"和文档里长得一样"。
 */
function StyledBox({
  children,
  className,
  css,
}: {
  children: ReactNode;
  className: string;
  css: string;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (box.current) {
      box.current.style.cssText = css;
    }
  }, [css]);

  return (
    <div className={className} ref={box}>
      {children}
    </div>
  );
}

/** img 上的样式量少且固定，直接拆成 React 的 style 对象即可。 */
function cssObject(css: string): Record<string, string> {
  return Object.fromEntries(
    css
      .split(";")
      .filter(Boolean)
      .map((declaration) => {
        const [property = "", value = ""] = declaration.split(":");
        return [property.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value];
      }),
  );
}

/** 让整幅图（含旋转后的外接盒）正好放进台面。 */
function fitWidth(attrs: ImageAttrs, rotate: ImageRotation): number {
  const width = attrs.width ?? STAGE.width;
  const height = attrs.height ?? STAGE.height;
  const quarter = rotate === 90 || rotate === 270;
  const outer = quarter ? { width: height, height: width } : { width, height };
  const scale = Math.min(STAGE.width / outer.width, STAGE.height / outer.height, 1);
  return Math.max(1, Math.round(width * scale));
}

/** 属性里的裁剪是原图坐标，台上看到的是转过之后的画面，两边要来回换。 */
function toDisplayCrop(crop: ImageCrop | null, rotate: ImageRotation): ImageCrop {
  const full = { x: 0, y: 0, width: 1, height: 1 };
  return unrotateCrop(crop ?? full, inverseRotation(rotate));
}

function inverseRotation(rotate: ImageRotation): ImageRotation {
  return rotate === 90 ? 270 : rotate === 270 ? 90 : rotate;
}

function turn(rotate: ImageRotation, direction: 1 | -1): ImageRotation {
  return ((((rotate + direction * 90) % 360) + 360) % 360) as ImageRotation;
}

type DragMode = "draw" | "move" | "nw" | "ne" | "sw" | "se";

/** 拖拽换算：四个角各自钉住对角，移动则整体平移，全程夹在画面内。 */
function resize(mode: DragMode, origin: ImageCrop, dx: number, dy: number): ImageCrop {
  if (mode === "move") {
    return {
      ...origin,
      x: clamp(origin.x + dx, 0, 1 - origin.width),
      y: clamp(origin.y + dy, 0, 1 - origin.height),
    };
  }
  if (mode === "draw") {
    const x = clamp(origin.x + Math.min(dx, 0), 0, 1);
    const y = clamp(origin.y + Math.min(dy, 0), 0, 1);
    return {
      x,
      y,
      width: clamp(Math.abs(dx), MIN_CROP, 1 - x),
      height: clamp(Math.abs(dy), MIN_CROP, 1 - y),
    };
  }
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;
  const west = mode === "nw" || mode === "sw";
  const north = mode === "nw" || mode === "ne";
  const x = west ? clamp(origin.x + dx, 0, right - MIN_CROP) : origin.x;
  const y = north ? clamp(origin.y + dy, 0, bottom - MIN_CROP) : origin.y;
  return {
    x,
    y,
    width: west ? right - x : clamp(origin.width + dx, MIN_CROP, 1 - x),
    height: north ? bottom - y : clamp(origin.height + dy, MIN_CROP, 1 - y),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
