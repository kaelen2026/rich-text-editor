import {
  type ToolbarDefinition,
  type ToolbarEffect,
  type ToolbarItemState,
  ToolbarModel,
} from "@kaelen/editor-ui-model";
import { useEditor, useEditorSnapshot } from "@kaelen/editor-vue";
import { defineComponent, h, type PropType, ref, type VNodeChild } from "vue";

export const EditorToolbar = defineComponent({
  name: "EditorToolbar",
  props: {
    definition: { type: Object as PropType<ToolbarDefinition>, required: true },
    className: { type: String, default: undefined },
    renderMenu: {
      type: Function as PropType<(item: ToolbarItemState, close: () => void) => VNodeChild>,
      default: undefined,
    },
    onExecute: {
      type: Function as PropType<(item: ToolbarItemState) => boolean | undefined>,
      default: undefined,
    },
  },
  setup(props) {
    const editor = useEditor();
    const state = useEditorSnapshot();
    const model = new ToolbarModel(props.definition, (command, input) =>
      editor.queryCommand(command, input),
    );
    const version = ref(0);
    const refresh = (effect: ToolbarEffect) => {
      if (effect.type === "none") return;
      version.value += 1;
      if (effect.type === "focus")
        document.getElementById(`editor-toolbar-${effect.itemId}`)?.focus();
    };
    return () => {
      state.value;
      version.value;
      const snapshot = model.snapshot;
      return h(
        "div",
        {
          role: "toolbar",
          "aria-label": snapshot.label,
          class: props.className,
          onKeydown: (event: KeyboardEvent) => {
            const effect = model.handleKey(event.key);
            if (effect.type !== "none") {
              event.preventDefault();
              refresh(effect);
            }
          },
        },
        snapshot.groups.map((group) =>
          h(
            "fieldset",
            { class: "editor-toolbar-group", "aria-label": group.label },
            group.items.flatMap((definitionItem) => {
              const item = snapshot.items.find((candidate) => candidate.id === definitionItem.id);
              if (!item) return [];
              const menuId = `${item.id}-menu`;
              return h("span", { class: "editor-toolbar-item" }, [
                h(
                  "button",
                  {
                    type: "button",
                    disabled: !item.enabled,
                    tabindex: item.tabIndex,
                    title: item.shortcut ? `${item.label}（${item.shortcut}）` : item.label,
                    "aria-pressed": item.menu ? undefined : item.active,
                    "aria-expanded": item.menu ? item.expanded : undefined,
                    "aria-controls": item.menu ? menuId : undefined,
                    "aria-haspopup": item.menu ? "menu" : undefined,
                    "data-active": item.active,
                    id: `editor-toolbar-${item.id}`,
                    onMousedown: (event: MouseEvent) => event.preventDefault(),
                    onFocus: () => refresh(model.focus(item.id)),
                    onClick: () => {
                      if (item.menu) return refresh(model.toggleMenu(item.id));
                      if (props.onExecute?.(item) !== true)
                        editor.execute(item.command, item.input);
                    },
                  },
                  item.label,
                ),
                item.menu && item.expanded && props.renderMenu
                  ? h(
                      "div",
                      {
                        id: menuId,
                        role: "menu",
                        "aria-label": `${item.label}菜单`,
                        onKeydown: (event: KeyboardEvent) => {
                          if (event.key === "Escape") {
                            event.preventDefault();
                            refresh(model.closeMenu());
                          }
                        },
                      },
                      [props.renderMenu(item, () => refresh(model.closeMenu()))],
                    )
                  : null,
              ]);
            }),
          ),
        ),
      );
    };
  },
});
