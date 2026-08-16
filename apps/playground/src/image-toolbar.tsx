import type { ImageAlign } from "@kaelen/editor-plugin-image";
import { useEditor, useEditorSelector } from "@kaelen/editor-react";
import {
  type LucideIcon,
  Replace,
  RotateCcw,
  RotateCw,
  SlidersHorizontal,
  TextAlignCenter,
  TextAlignEnd,
  TextAlignJustify,
  TextAlignStart,
  Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImageModal, type SelectedImage } from "./image-modal";

const ALIGN_PRESETS: readonly { label: string; align: ImageAlign; icon: LucideIcon }[] = [
  { label: "独占一行", align: "none", icon: TextAlignJustify },
  { label: "左侧环绕", align: "left", icon: TextAlignStart },
  { label: "居中", align: "center", icon: TextAlignCenter },
  { label: "右侧环绕", align: "right", icon: TextAlignEnd },
];

/**
 * 选中图片后浮在它上方的快捷条，双击图片则进入模态精修。
 *
 * 分工是"对这张图做什么"与"这张图长什么样"：转向、环绕、替换、删除都是一下就好
 * 的动作，直接落事务；裁剪、滤镜、尺寸与替代文本要边看边调，交给模态的草稿。
 *
 * 命令都带上 `image.selected` 交回的 `pos`，因此浮层或模态拿走焦点之后，改的仍然
 * 是同一张图。
 */
export function ImageToolbar() {
  const editor = useEditor();
  const mode = useEditorSelector((snapshot) => snapshot.mode);
  const stateRevision = useEditorSelector((snapshot) => snapshot.stateRevision);
  // stateRevision 不是被读的值，而是"任意状态变更（含选区）"的水位线：涨一格就重问一次命令。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  const selected = useMemo<SelectedImage | null>(() => {
    const result = editor.execute("image.selected");
    return result.ok ? (result.detail as SelectedImage) : null;
  }, [editor, stateRevision]);

  const editable = mode === "edit" && selected !== null;
  const anchor = useImageAnchor(editable, stateRevision);
  const [editing, setEditing] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);

  // 双击图片进模态：这是最直觉的"我要好好改这张图"，不必先找工具条。
  useEffect(() => {
    const onDoubleClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".ProseMirror .co-image")) {
        setEditing(true);
      }
    };
    document.addEventListener("dblclick", onDoubleClick);
    return () => document.removeEventListener("dblclick", onDoubleClick);
  }, []);

  useEffect(() => {
    if (!editable) {
      setEditing(false);
    }
  }, [editable]);

  if (!selected || !editable) {
    return null;
  }

  const run = (command: string, input: Record<string, unknown> = {}) => {
    editor.execute(command, { pos: selected.pos, ...input });
    editor.focus();
  };

  return (
    <>
      {editing
        ? createPortal(
            <ImageModal onClose={() => setEditing(false)} selected={selected} />,
            document.body,
          )
        : null}
      {anchor && !editing
        ? createPortal(
            <div
              aria-label="图片"
              className="image-bar"
              onMouseDown={(event) => event.preventDefault()}
              role="toolbar"
              style={placement(anchor)}
            >
              <button
                className="image-bar-button image-bar-wide"
                onClick={() => setEditing(true)}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                <SlidersHorizontal aria-hidden="true" size={16} strokeWidth={1.75} />
                编辑图片
              </button>

              <span className="image-bar-divider" />

              <BarButton
                disabled={selected.naturalSize === null}
                icon={RotateCcw}
                label="向左旋转"
                onClick={() => run("image.rotate", { turn: -1 })}
              />
              <BarButton
                disabled={selected.naturalSize === null}
                icon={RotateCw}
                label="向右旋转"
                onClick={() => run("image.rotate", { turn: 1 })}
              />

              <Popover icon={alignIcon(selected.attrs.align)} label="对齐与环绕">
                {(close) =>
                  ALIGN_PRESETS.map((preset) => (
                    <button
                      className="menu-item"
                      data-active={selected.attrs.align === preset.align}
                      key={preset.align}
                      onClick={() => {
                        run("image.setAlign", { align: preset.align });
                        close();
                      }}
                      onMouseDown={(event) => event.preventDefault()}
                      role="menuitem"
                      type="button"
                    >
                      <preset.icon aria-hidden="true" size={15} strokeWidth={1.75} />
                      <span className="menu-item-label">{preset.label}</span>
                    </button>
                  ))
                }
              </Popover>

              <span className="image-bar-divider" />

              <BarButton
                icon={Replace}
                label="替换图片"
                onClick={() => replaceInput.current?.click()}
              />
              <BarButton
                danger
                icon={Trash2}
                label="删除图片"
                onClick={() => run("image.remove")}
              />
              <input
                accept="image/*"
                hidden
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) {
                    run("image.replace", { file });
                  }
                }}
                ref={replaceInput}
                type="file"
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

/**
 * 被整节点选中的图片在屏幕上的位置。
 *
 * 图片是异步加载的，尺寸随时会变，因此除了状态水位线之外还要盯着元素本身的
 * 尺寸变化与滚动，否则浮层会停在图片原来的地方。
 */
function useImageAnchor(active: boolean, revision: number): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null);

  // revision 同样是水位线：选中的图片换了一张，就要重新去 DOM 里找锚点。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 见上
  useEffect(() => {
    const element = active
      ? document.querySelector<HTMLElement>(".ProseMirror .co-image.ProseMirror-selectednode")
      : null;
    if (!element) {
      setRect(null);
      return;
    }
    const measure = () => setRect(element.getBoundingClientRect());
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [active, revision]);

  return rect;
}

/** 优先浮在图片上方；顶上放不下就翻到下方，横向夹在视口里不跑出去。 */
function placement(anchor: DOMRect): { top: number; left: number; transform: string } {
  const above = anchor.top - 12;
  const flip = above < 56;
  return {
    top: flip ? anchor.bottom + 12 : above,
    left: clamp(anchor.left + anchor.width / 2, 180, Math.max(180, window.innerWidth - 180)),
    transform: flip ? "translateX(-50%)" : "translate(-50%, -100%)",
  };
}

function alignIcon(align: ImageAlign): LucideIcon {
  return ALIGN_PRESETS.find((preset) => preset.align === align)?.icon ?? TextAlignJustify;
}

function BarButton({
  danger,
  disabled,
  icon: Icon,
  label,
  onClick,
}: {
  danger?: boolean;
  disabled?: boolean;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className={danger ? "image-bar-button image-bar-danger" : "image-bar-button"}
      disabled={disabled}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      type="button"
    >
      <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
      <span aria-hidden="true" className="tip">
        {label}
      </span>
    </button>
  );
}

/** 浮层里的下拉。点到面板外面才关，点触发器本身由按钮自己处理。 */
function Popover({
  children,
  icon: Icon,
  label,
}: {
  children: (close: () => void) => ReactNode;
  icon: LucideIcon;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const item = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!item.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <span className="image-bar-item" ref={item}>
      <button
        aria-expanded={open}
        aria-haspopup="true"
        aria-label={label}
        className="image-bar-button"
        onClick={() => setOpen((current) => !current)}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        <Icon aria-hidden="true" size={16} strokeWidth={1.75} />
        <span aria-hidden="true" className="tip">
          {label}
        </span>
      </button>
      {open ? <div className="image-bar-menu">{children(() => setOpen(false))}</div> : null}
    </span>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
