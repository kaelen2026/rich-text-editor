import { useEffect, useRef } from "react";
import { useEditor } from "./editor-context";

export interface EditorContentProps {
  className?: string;
  /** Exposed on the editable element itself, not only its visual wrapper. */
  ariaLabel?: string;
}

/**
 * 编辑区容器。挂载时 `mount`，卸载时 `unmount`——**不是 `destroy`**：
 * 视图生命周期属于框架适配层，实例生命周期属于创建者（方案 §10.1）。
 *
 * StrictMode 在开发模式下会 mount → unmount → mount，因此依赖 `mount`/`unmount`
 * 的幂等性（方案 §8.2）。
 */
export function EditorContent({ className, ariaLabel = "富文本编辑器" }: EditorContentProps) {
  const editor = useEditor();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    editor.mount(host);
    host.querySelector<HTMLElement>(".ProseMirror")?.setAttribute("aria-label", ariaLabel);
    return () => editor.unmount();
  }, [ariaLabel, editor]);

  return <div ref={hostRef} className={className} />;
}
