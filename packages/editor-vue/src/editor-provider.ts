import type { RichEditor } from "@kaelen/editor-api";
import { defineComponent, type PropType } from "vue";
import { provideEditor } from "./editor-context";

/** Vue 只提供实例与宿主树；实例的 destroy 仍由业务创建者负责。 */
export const EditorProvider = defineComponent({
  name: "EditorProvider",
  props: {
    editor: { type: Object as PropType<RichEditor>, required: true },
  },
  setup(props, { slots }) {
    provideEditor(props.editor);
    return () => slots.default?.();
  },
});
