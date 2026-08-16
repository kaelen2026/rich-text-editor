import { useEditor, useEditorSnapshot } from "@kaelen/editor-react";
import {
  type ToolbarDefinition,
  type ToolbarEffect,
  type ToolbarItemState,
  ToolbarModel,
} from "@kaelen/editor-ui-model";
import { type MouseEvent, type ReactNode, useMemo, useRef, useState } from "react";

export interface EditorToolbarProps {
  definition: ToolbarDefinition;
  className?: string;
  /** Render a menu's contents. Escape always returns focus to its trigger. */
  renderMenu?: (item: ToolbarItemState, close: () => void) => ReactNode;
  /**
   * Replace a button's visible content, for example with an icon. The accessible
   * name stays `item.label`, so icon-only toolbars keep their screen reader text.
   */
  renderLabel?: (item: ToolbarItemState) => ReactNode;
  /**
   * Set to false when the host draws its own tooltip. The native `title` tooltip would
   * otherwise appear on top of it a second later. The accessible name is unaffected.
   */
  nativeTooltip?: boolean;
  /** Allows hosts to supply a native file picker or another non-command action. */
  onExecute?: (item: ToolbarItemState) => boolean | undefined;
}

/**
 * Accessible React renderer for the framework-free toolbar model. It deliberately
 * contains no command, focus-order or popover state of its own.
 */
export function EditorToolbar({
  definition,
  className,
  renderMenu,
  renderLabel,
  nativeTooltip = true,
  onExecute,
}: EditorToolbarProps) {
  const editor = useEditor();
  useEditorSnapshot();
  const model = useMemo(
    () => new ToolbarModel(definition, (command, input) => editor.queryCommand(command, input)),
    [definition, editor],
  );
  const [, setVersion] = useState(0);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const snapshot = model.snapshot;

  const apply = (effect: ToolbarEffect) => {
    if (effect.type === "none") {
      return;
    }
    setVersion((version) => version + 1);
    if (effect.type === "focus") {
      controls.current.get(effect.itemId)?.focus();
    }
  };

  const preventSelectionLoss = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

  return (
    <div
      aria-label={snapshot.label}
      className={className}
      onKeyDown={(event) => {
        const effect = model.handleKey(event.key);
        if (effect.type !== "none") {
          event.preventDefault();
          apply(effect);
        }
      }}
      role="toolbar"
    >
      {snapshot.groups.map((group) => (
        <fieldset aria-label={group.label} className="editor-toolbar-group" key={group.label}>
          {group.items.map((definitionItem) => {
            const item = snapshot.items.find((state) => state.id === definitionItem.id);
            if (!item) {
              return null;
            }
            const menuId = `${item.id}-menu`;
            return (
              <span className="editor-toolbar-item" key={item.id}>
                <button
                  aria-controls={item.menu ? menuId : undefined}
                  aria-expanded={item.menu ? item.expanded : undefined}
                  aria-haspopup={item.menu ? "menu" : undefined}
                  aria-label={item.label}
                  aria-pressed={item.menu ? undefined : item.active}
                  data-active={item.active}
                  data-value={item.value ?? undefined}
                  disabled={!item.enabled}
                  onClick={() => {
                    if (item.menu) {
                      apply(model.toggleMenu(item.id));
                      return;
                    }
                    if (onExecute?.(item) !== true) {
                      editor.execute(item.command, item.input);
                    }
                  }}
                  onFocus={() => apply(model.focus(item.id))}
                  onMouseDown={preventSelectionLoss}
                  ref={(element) => {
                    if (element) {
                      controls.current.set(item.id, element);
                    } else {
                      controls.current.delete(item.id);
                    }
                  }}
                  tabIndex={item.tabIndex}
                  title={
                    nativeTooltip
                      ? item.shortcut
                        ? `${item.label}（${item.shortcut}）`
                        : item.label
                      : undefined
                  }
                  type="button"
                >
                  {renderLabel ? renderLabel(item) : item.label}
                </button>
                {item.menu && item.expanded && renderMenu ? (
                  <div
                    aria-label={`${item.label}菜单`}
                    id={menuId}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        apply(model.closeMenu());
                      }
                    }}
                    role="menu"
                  >
                    {renderMenu(item, () => apply(model.closeMenu()))}
                  </div>
                ) : null}
              </span>
            );
          })}
        </fieldset>
      ))}
    </div>
  );
}
