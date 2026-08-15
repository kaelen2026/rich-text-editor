import type { CommandQuery, EditorMode } from "@kaelen/editor-shared-types";

export interface ToolbarItemDefinition {
  /** Stable identifier used for DOM ids and restoring focus after a popover closes. */
  id: string;
  label: string;
  command: string;
  input?: unknown;
  shortcut?: string;
  /** Use for browser-native controls such as a file picker that have no queryable editor command. */
  alwaysEnabled?: boolean;
  /** A menu trigger reports its expanded state and participates in Escape handling. */
  menu?: boolean;
}

export interface ToolbarGroupDefinition {
  label: string;
  items: readonly ToolbarItemDefinition[];
}

export interface ToolbarDefinition {
  label: string;
  groups: readonly ToolbarGroupDefinition[];
}

export interface ToolbarItemQuery extends CommandQuery {
  /** Optional command-specific display value, such as a selected font size. */
  value?: string | number | boolean | null;
}

export interface ToolbarItemState extends ToolbarItemDefinition, ToolbarItemQuery {
  tabIndex: 0 | -1;
  expanded: boolean;
}

export interface ToolbarSnapshot {
  label: string;
  groups: readonly ToolbarGroupDefinition[];
  items: readonly ToolbarItemState[];
  openMenuId?: string;
}

export type ToolbarEffect =
  | { type: "none" }
  | { type: "focus"; itemId: string }
  | { type: "openMenu"; itemId: string }
  | { type: "closeMenu"; itemId: string };

type QueryCommand = (command: string, input?: unknown) => ToolbarItemQuery;

/**
 * Framework-free state machine for toolbar behavior. The renderer owns DOM focus,
 * while this model owns the order, roving tab stop, menu state and Escape result.
 */
export class ToolbarModel {
  private readonly items: readonly ToolbarItemDefinition[];
  private focusedIndex = 0;
  private openMenuId: string | undefined;

  constructor(
    private readonly definition: ToolbarDefinition,
    private readonly queryCommand: QueryCommand,
  ) {
    this.items = definition.groups.flatMap((group) => group.items);
    this.focusedIndex = this.firstEnabledIndex();
  }

  get snapshot(): ToolbarSnapshot {
    const enabledIndex = this.firstEnabledIndex();
    if (!this.isEnabled(this.focusedIndex)) {
      this.focusedIndex = enabledIndex;
    }
    return {
      label: this.definition.label,
      groups: this.definition.groups,
      items: this.items.map((item, index) => {
        const query = this.query(item);
        return {
          ...item,
          ...query,
          tabIndex: index === this.focusedIndex && query.enabled ? 0 : -1,
          expanded: item.menu === true && item.id === this.openMenuId,
        };
      }),
      ...(this.openMenuId ? { openMenuId: this.openMenuId } : {}),
    };
  }

  focus(itemId: string): ToolbarEffect {
    const index = this.items.findIndex((item) => item.id === itemId);
    if (index < 0 || !this.isEnabled(index)) {
      return { type: "none" };
    }
    this.focusedIndex = index;
    return { type: "focus", itemId };
  }

  handleKey(key: string): ToolbarEffect {
    if (key === "Escape" && this.openMenuId) {
      const itemId = this.openMenuId;
      this.openMenuId = undefined;
      return { type: "focus", itemId };
    }
    if (key === "ArrowRight" || key === "ArrowDown") {
      return this.move(1);
    }
    if (key === "ArrowLeft" || key === "ArrowUp") {
      return this.move(-1);
    }
    if (key === "Home") {
      return this.moveTo(this.firstEnabledIndex());
    }
    if (key === "End") {
      return this.moveTo(this.lastEnabledIndex());
    }
    return { type: "none" };
  }

  toggleMenu(itemId: string): ToolbarEffect {
    const item = this.items.find((candidate) => candidate.id === itemId);
    if (!item?.menu || !this.query(item).enabled) {
      return { type: "none" };
    }
    this.focus(itemId);
    if (this.openMenuId === itemId) {
      this.openMenuId = undefined;
      return { type: "closeMenu", itemId };
    }
    this.openMenuId = itemId;
    return { type: "openMenu", itemId };
  }

  closeMenu(): ToolbarEffect {
    if (!this.openMenuId) {
      return { type: "none" };
    }
    const itemId = this.openMenuId;
    this.openMenuId = undefined;
    return { type: "focus", itemId };
  }

  private move(direction: 1 | -1): ToolbarEffect {
    if (this.items.length === 0 || this.firstEnabledIndex() === -1) {
      return { type: "none" };
    }
    for (let offset = 1; offset <= this.items.length; offset += 1) {
      const index =
        (this.focusedIndex + direction * offset + this.items.length) % this.items.length;
      if (this.isEnabled(index)) {
        return this.moveTo(index);
      }
    }
    return { type: "none" };
  }

  private moveTo(index: number): ToolbarEffect {
    if (index < 0 || !this.isEnabled(index)) {
      return { type: "none" };
    }
    this.focusedIndex = index;
    const item = this.items[index];
    return item ? { type: "focus", itemId: item.id } : { type: "none" };
  }

  private firstEnabledIndex(): number {
    return this.items.findIndex((_, index) => this.isEnabled(index));
  }

  private lastEnabledIndex(): number {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.isEnabled(index)) {
        return index;
      }
    }
    return -1;
  }

  private isEnabled(index: number): boolean {
    const item = this.items[index];
    return item ? this.query(item).enabled : false;
  }

  private query(item: ToolbarItemDefinition): ToolbarItemQuery {
    const query = this.queryCommand(item.command, item.input);
    return item.alwaysEnabled ? { ...query, enabled: true } : query;
  }
}

export interface FloatingToolbarInput {
  mode: EditorMode;
  selection: Pick<{ empty: boolean }, "empty">;
  anchorRect?: DOMRect | Rect;
  viewport: Size;
  toolbarSize: Size;
  gap?: number;
}

export interface Rect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export type FloatingToolbarState =
  | { visible: false }
  | { visible: true; placement: "top" | "bottom"; x: number; y: number };

/** Computes display and clamped coordinates without reading DOM globals. */
export function getFloatingToolbarState(input: FloatingToolbarInput): FloatingToolbarState {
  const { anchorRect } = input;
  if (input.mode !== "edit" || input.selection.empty || !anchorRect) {
    return { visible: false };
  }
  const gap = input.gap ?? 8;
  const x = clamp(
    anchorRect.left + anchorRect.width / 2 - input.toolbarSize.width / 2,
    gap,
    Math.max(gap, input.viewport.width - input.toolbarSize.width - gap),
  );
  const bottomY = anchorRect.bottom + gap;
  if (bottomY + input.toolbarSize.height <= input.viewport.height - gap) {
    return { visible: true, placement: "bottom", x, y: bottomY };
  }
  return {
    visible: true,
    placement: "top",
    x,
    y: Math.max(gap, anchorRect.top - input.toolbarSize.height - gap),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
