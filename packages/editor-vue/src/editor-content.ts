import { defineComponent, h, onBeforeUnmount, onMounted, ref } from "vue";
import { useEditor } from "./editor-context";

/** Mount/unmount are view lifecycle operations; this component never destroys the editor instance. */
export const EditorContent = defineComponent({
  name: "EditorContent",
  props: {
    className: { type: String, default: undefined },
    ariaLabel: { type: String, default: "富文本编辑器" },
  },
  setup(props) {
    const editor = useEditor();
    const host = ref<HTMLDivElement>();
    onMounted(() => {
      if (!host.value) return;
      editor.mount(host.value);
      host.value
        .querySelector<HTMLElement>(".ProseMirror")
        ?.setAttribute("aria-label", props.ariaLabel);
    });
    onBeforeUnmount(() => editor.unmount());
    return () => h("div", { ref: host, class: props.className });
  },
});
