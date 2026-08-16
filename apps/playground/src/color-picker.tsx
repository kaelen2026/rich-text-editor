import { useEditor } from "@kaelen/editor-react";
import { Check, Copy, Eraser, Pipette } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from "react";

/**
 * 取色面板。它只认插件的命令，不认标记：面板挑出十六进制颜色，
 * 校验与持久化仍然由 color 插件说了算。
 */
export interface ColorPickerMenu {
  label: string;
  setCommand: string;
  unsetCommand: string;
  readCommand: string;
  /** 选区还没上色时，面板从这个颜色起步。 */
  fallback: string;
}

interface HSVA {
  /** 0–360 */
  h: number;
  /** 0–1 */
  s: number;
  /** 0–1 */
  v: number;
  /** 0–1 */
  a: number;
}

interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

interface EyeDropperResult {
  sRGBHex: string;
}

type EyeDropperConstructor = new () => { open(): Promise<EyeDropperResult> };

export function ColorPicker({ menu, onClose }: { menu: ColorPickerMenu; onClose: () => void }) {
  const editor = useEditor();
  const [draft, setDraft] = useState<HSVA>(() => toHSVA(currentColor(editor, menu)));
  // 手输的十六进制单独存：输到一半的 "#d9" 不该被当成颜色回写进滑杆。
  const [typedHex, setTypedHex] = useState(() => formatHex(toRGBA(draft)));
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const clear = editor.queryCommand(menu.unsetCommand);
  const hex = formatHex(toRGBA(draft));
  const css = toCSS(toRGBA(draft));
  // 光标态没有可上色的范围，命令自己会拒绝；面板据此直接停用，不做无声的空转。
  const canApply = editor.queryCommand(menu.setCommand, { color: hex }).enabled;

  /** commit=false 只动面板，commit=true 才写文档——拖动过程不该拆成上百个事务。 */
  function update(next: HSVA, commit: boolean) {
    setDraft(next);
    setTypedHex(formatHex(toRGBA(next)));
    if (commit) {
      editor.execute(menu.setCommand, { color: formatHex(toRGBA(next)) });
    }
  }

  function updateFromPointer(event: ReactPointerEvent<HTMLDivElement>, commit: boolean) {
    const rect = event.currentTarget.getBoundingClientRect();
    update(
      {
        ...draft,
        s: clamp((event.clientX - rect.left) / rect.width),
        v: 1 - clamp((event.clientY - rect.top) / rect.height),
      },
      commit,
    );
  }

  async function copyColor() {
    try {
      await navigator.clipboard?.writeText(hex);
    } catch {
      // 非安全上下文或用户拒权：不弹错，按钮保持原样。
      return;
    }
    setCopied(true);
    // 面板可能在提示消失前就关掉，计时器必须能被清掉。
    window.clearTimeout(copiedTimer.current);
    copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
  }

  async function pickFromScreen() {
    const EyeDropper = (window as unknown as { EyeDropper?: EyeDropperConstructor }).EyeDropper;
    if (!EyeDropper) {
      return;
    }
    try {
      const { sRGBHex } = await new EyeDropper().open();
      const picked = parseHex(sRGBHex);
      if (picked) {
        // 吸管只取色相，不动当前的不透明度。
        update({ ...toHSVA(sRGBHex), a: draft.a }, true);
      }
    } catch {
      // 用户按 Esc 取消取色，什么都不做。
    }
  }

  return (
    <div className="picker">
      {/* 拖动期间按住指针不放焦点：编辑区的选区一丢，上色就没有作用范围了。 */}
      <div
        aria-disabled={!canApply}
        className="picker-field"
        onPointerDown={(event) => {
          event.preventDefault();
          if (!canApply) {
            return;
          }
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          updateFromPointer(event, false);
        }}
        onPointerMove={(event) => {
          if (dragging) {
            updateFromPointer(event, false);
          }
        }}
        onPointerUp={(event) => {
          if (!dragging) {
            return;
          }
          setDragging(false);
          updateFromPointer(event, true);
        }}
        style={{ background: fieldBackground(draft.h) }}
      >
        <span
          className="picker-cursor"
          style={{
            insetInlineStart: `${draft.s * 100}%`,
            insetBlockStart: `${(1 - draft.v) * 100}%`,
            background: css,
          }}
        />
        {/* 色域方块靠指针操作，键盘与读屏走这两个滑杆。 */}
        <input
          aria-label="饱和度"
          className="picker-axis"
          disabled={!canApply}
          max={100}
          min={0}
          onChange={(event) => update({ ...draft, s: Number(event.target.value) / 100 }, false)}
          onBlur={() => update(draft, true)}
          onKeyUp={() => update(draft, true)}
          onPointerUp={() => update(draft, true)}
          type="range"
          value={Math.round(draft.s * 100)}
        />
        <input
          aria-label="明度"
          className="picker-axis"
          disabled={!canApply}
          max={100}
          min={0}
          onChange={(event) => update({ ...draft, v: Number(event.target.value) / 100 }, false)}
          onBlur={() => update(draft, true)}
          onKeyUp={() => update(draft, true)}
          onPointerUp={() => update(draft, true)}
          type="range"
          value={Math.round(draft.v * 100)}
        />
      </div>

      <div className="picker-controls">
        <button
          className="picker-pipette"
          disabled={!canApply || !("EyeDropper" in window)}
          onClick={pickFromScreen}
          onPointerDown={(event) => event.preventDefault()}
          title="从屏幕取色"
          type="button"
        >
          <Pipette aria-hidden="true" size={15} strokeWidth={1.75} />
          <span className="sr-only">从屏幕取色</span>
        </button>
        {/* 预览圆点兼作复制按钮：调好的颜色常常还要拿去别处用。 */}
        <button
          aria-label={`复制颜色 ${hex}`}
          className="picker-preview"
          onClick={copyColor}
          onPointerDown={(event) => event.preventDefault()}
          style={{ backgroundImage: `linear-gradient(${css}, ${css}), var(--checker)` }}
          type="button"
        >
          {copied ? (
            <Check aria-hidden="true" size={14} strokeWidth={2.25} />
          ) : (
            <Copy aria-hidden="true" size={13} strokeWidth={2} />
          )}
          <span aria-hidden="true" className="tip">
            {copied ? "已复制" : "复制颜色到剪贴板"}
          </span>
        </button>
        <div className="picker-sliders">
          <input
            aria-label="色相"
            className="picker-hue"
            disabled={!canApply}
            max={360}
            min={0}
            onChange={(event) => update({ ...draft, h: Number(event.target.value) }, false)}
            onBlur={() => update(draft, true)}
            onKeyUp={() => update(draft, true)}
            onPointerUp={() => update(draft, true)}
            type="range"
            value={Math.round(draft.h)}
          />
          <input
            aria-label="不透明度"
            className="picker-alpha"
            disabled={!canApply}
            max={100}
            min={0}
            onChange={(event) => update({ ...draft, a: Number(event.target.value) / 100 }, false)}
            onBlur={() => update(draft, true)}
            onKeyUp={() => update(draft, true)}
            onPointerUp={() => update(draft, true)}
            style={
              {
                "--picker-clear": toCSS({ ...toRGBA(draft), a: 0 }),
                "--picker-opaque": toCSS({ ...toRGBA(draft), a: 1 }),
              } as React.CSSProperties
            }
            type="range"
            value={Math.round(draft.a * 100)}
          />
        </div>
      </div>

      <div className="picker-fields">
        <label className="picker-field-label">
          <input
            className="picker-input"
            disabled={!canApply}
            inputMode="text"
            onChange={(event) => {
              setTypedHex(event.target.value);
              const parsed = parseHex(event.target.value);
              if (parsed) {
                setDraft(toHSVA(formatHex(parsed)));
              }
            }}
            onBlur={() => {
              const parsed = parseHex(typedHex);
              // 输错了就回到面板当前的颜色，不留一个无效值在框里。
              update(parsed ? toHSVA(formatHex(parsed)) : draft, Boolean(parsed));
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            spellCheck={false}
            value={typedHex}
          />
          <span>hex</span>
        </label>
        <label className="picker-field-label">
          <input
            className="picker-input"
            disabled={!canApply}
            max={100}
            min={0}
            onChange={(event) =>
              update({ ...draft, a: clamp(Number(event.target.value) / 100) }, true)
            }
            type="number"
            value={Math.round(draft.a * 100)}
          />
          <span>A %</span>
        </label>
        {/* 色值已经在 hex 框里，这行只在没法上色时说明原因。 */}
        {canApply ? null : (
          <span className="picker-readout" role="status">
            先选中文字
          </span>
        )}
      </div>

      <button
        className="menu-item"
        disabled={!clear.enabled}
        onClick={() => {
          editor.execute(menu.unsetCommand);
          onClose();
        }}
        onPointerDown={(event) => event.preventDefault()}
        role="menuitem"
        type="button"
      >
        <Eraser aria-hidden="true" size={15} strokeWidth={1.75} />
        <span className="menu-item-label">清除{menu.label}</span>
      </button>
    </div>
  );
}

/** 面板打开时对齐选区已有的颜色，没有就用兜底色。 */
function currentColor(editor: ReturnType<typeof useEditor>, menu: ColorPickerMenu): string {
  const result = editor.execute(menu.readCommand);
  const detail = result.detail;
  if (result.ok && typeof detail === "object" && detail !== null && "color" in detail) {
    const color = (detail as { color: unknown }).color;
    if (typeof color === "string") {
      return color;
    }
  }
  return menu.fallback;
}

function fieldBackground(hue: number): string {
  return [
    "linear-gradient(to top, rgb(0, 0, 0), rgba(0, 0, 0, 0))",
    "linear-gradient(to right, rgb(255, 255, 255), rgba(255, 255, 255, 0))",
    `hsl(${Math.round(hue)}, 100%, 50%)`,
  ].join(", ");
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

/** `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`，与插件的白名单一致。 */
function parseHex(value: string): RGBA | undefined {
  const hex = value.trim().toLowerCase();
  if (!/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(hex)) {
    return undefined;
  }
  const digits = hex.slice(1);
  const short = digits.length <= 4;
  const size = short ? 1 : 2;
  const channels: number[] = [];
  for (let index = 0; index < digits.length; index += size) {
    const pair = digits.slice(index, index + size);
    channels.push(Number.parseInt(short ? `${pair}${pair}` : pair, 16));
  }
  const [r = 0, g = 0, b = 0, alpha = 255] = channels;
  return { r, g, b, a: alpha / 255 };
}

function formatHex({ r, g, b, a }: RGBA): string {
  const channels = [r, g, b].map(toHexByte).join("");
  return a >= 1 ? `#${channels}` : `#${channels}${toHexByte(Math.round(a * 255))}`;
}

function toHexByte(value: number): string {
  return Math.min(255, Math.max(0, Math.round(value)))
    .toString(16)
    .padStart(2, "0");
}

function toCSS({ r, g, b, a }: RGBA): string {
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.round(a * 100) / 100})`;
}

function toHSVA(color: string): HSVA {
  const { r, g, b, a } = parseHex(color) ?? { r: 0, g: 0, b: 0, a: 1 };
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const span = max - min;
  let hue = 0;
  if (span !== 0) {
    if (max === red) {
      hue = ((green - blue) / span) % 6;
    } else if (max === green) {
      hue = (blue - red) / span + 2;
    } else {
      hue = (red - green) / span + 4;
    }
    hue *= 60;
  }
  return { h: (hue + 360) % 360, s: max === 0 ? 0 : span / max, v: max, a };
}

function toRGBA({ h, s, v, a }: HSVA): RGBA {
  const chroma = v * s;
  const second = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const match = v - chroma;
  const sector = Math.floor(h / 60) % 6;
  const table: readonly [number, number, number][] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const [red = 0, green = 0, blue = 0] = table[sector] ?? [0, 0, 0];
  return {
    r: Math.round((red + match) * 255),
    g: Math.round((green + match) * 255),
    b: Math.round((blue + match) * 255),
    a,
  };
}
