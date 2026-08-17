import { useEditor } from "@kaelen/editor-react";
import type { Annotation } from "@kaelen/editor-shared-types";
import { MessageSquareText, Trash2 } from "lucide-react";
import { useSyncExternalStore } from "react";

/** 评论的业务载荷。编辑器只负责锚点，payload 的形状由宿主自己定（§9.8）。 */
export interface CommentPayload {
  text: string;
}

function payloadText(annotation: Annotation): string {
  const payload = annotation.payload as Partial<CommentPayload> | null;
  return typeof payload?.text === "string" ? payload.text : "（无内容）";
}

/**
 * 评论侧栏。批注是文档外部的锚点表，不进正文也不进 `getHTML()`——
 * 这里直接订阅 `change` 读 `getAnnotations()`：引用在批注未变时稳定，
 * 打字不会白渲染这块面板。
 */
export function CommentPanel() {
  const editor = useEditor();
  const annotations = useSyncExternalStore(
    (notify) => editor.subscribe("change", notify),
    () => editor.getAnnotations(),
  );
  if (annotations.length === 0) {
    return null;
  }
  return (
    <aside className="comment-panel" aria-label="评论">
      <h2 className="comment-panel-title">
        <MessageSquareText aria-hidden="true" size={14} strokeWidth={1.75} />
        评论（{annotations.length}）
      </h2>
      <ul className="comment-list">
        {annotations.map((annotation) => (
          <li
            className="comment-item"
            data-comment-orphaned={annotation.orphaned || undefined}
            key={annotation.id}
          >
            <p className="comment-text">{payloadText(annotation)}</p>
            <p className="comment-meta">
              {annotation.orphaned ? (
                <span className="comment-orphaned">内容已删除</span>
              ) : (
                <span>
                  锚定 {annotation.from}–{annotation.to}
                </span>
              )}
              <button
                type="button"
                className="comment-remove"
                onClick={() => editor.execute("comment.remove", { id: annotation.id })}
                aria-label="删除评论"
              >
                <Trash2 aria-hidden="true" size={13} strokeWidth={1.75} />
              </button>
            </p>
          </li>
        ))}
      </ul>
    </aside>
  );
}
