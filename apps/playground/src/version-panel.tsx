import {
  appendVersionLogEntry,
  buildSchema,
  createVersionLog,
  documentAtRevision,
  versionLogTip,
} from "@kaelen/editor-pm-adapter";
import { useEditor } from "@kaelen/editor-react";
import { documentToMarkdown } from "@kaelen/editor-schema";
import type { EditorEnvelope, NodeJSON, VersionLog } from "@kaelen/editor-shared-types";
import { ChevronRight, History, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/** 面板给每个版本记的元数据。编辑器不解释它，形状是宿主自己的。 */
interface VersionMeta {
  at: string;
}

/**
 * 版本历史面板（S30 演示）。
 *
 * 宿主消费 `patch` 事件把变更累积成版本日志——"服务端按 patch 累积版本"
 * 在这里由页面代劳。查看与对比是对日志的纯重放，不经过编辑器；只有
 * "恢复"走 `version.restore`：它追加一笔反向变更，因此恢复本身也出现在
 * 时间轴上，并且可以被撤销。
 */
export function VersionPanel({ baseDocument }: { baseDocument: EditorEnvelope }) {
  const editor = useEditor();
  const [log, setLog] = useState<VersionLog>(() => createVersionLog(baseDocument.doc, 0));
  const [older, setOlder] = useState<number | null>(null);
  const [newer, setNewer] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setLog(createVersionLog(baseDocument.doc, 0));
    setOlder(null);
    setNewer(null);
    setNotice(null);
    return editor.subscribe("patch", (patch) => {
      setLog((current) => {
        const appended = appendVersionLogEntry(current, patch, {
          at: new Date().toISOString(),
        } satisfies VersionMeta);
        if (appended.ok) {
          return appended.log;
        }
        // 日志断链（比如订阅前就有编辑）：以当前文档另起一份，别装作能重放。
        setNotice(`修订号断链，已从修订号 ${editor.getRevision()} 重新开始记录。`);
        return createVersionLog(
          JSON.parse(JSON.stringify(editor.getDocument().doc)) as NodeJSON,
          editor.getRevision(),
        );
      });
    });
  }, [editor, baseDocument]);

  const tip = versionLogTip(log);
  const schema = useMemo(() => buildSchema(editor.getSchemaExtensions()), [editor]);

  const diff = useMemo(() => {
    if (older === null || newer === null) {
      return null;
    }
    const from = markdownAt(schema, log, Math.min(older, newer), editor);
    const to = markdownAt(schema, log, Math.max(older, newer), editor);
    if (from === null || to === null) {
      return null;
    }
    return diffLines(from.split("\n"), to.split("\n"));
  }, [older, newer, log, schema, editor]);

  function restore(revision: number) {
    const result = editor.execute("version.restore", { history: log, revision });
    setNotice(result.ok ? null : `恢复失败：${result.detail ?? result.reason}`);
  }

  const revisions = [log.baseRevision, ...log.entries.map((entry) => entry.patch.to)];

  return (
    <details className="console">
      <summary>
        <ChevronRight aria-hidden="true" className="disclosure" size={14} strokeWidth={2} />
        <span className="console-title">
          <History aria-hidden="true" size={14} strokeWidth={1.75} /> 版本历史
        </span>
        <span>{revisions.length} 个版本</span>
      </summary>
      <div className="console-body">
        <p>
          每次内容变更是一个版本。勾选两列单选框对比两个版本；“恢复”会追加一笔
          把内容改回去的新变更——它自己也出现在时间轴上，且可以撤销。
        </p>
        {notice ? <p className="banner banner-warn">{notice}</p> : null}
        <table className="version-table">
          <thead>
            <tr>
              <th scope="col">旧</th>
              <th scope="col">新</th>
              <th scope="col">版本</th>
              <th scope="col">时间</th>
              <th scope="col" aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {revisions.map((revision, index) => {
              const meta = index === 0 ? null : (log.entries[index - 1]?.meta as VersionMeta);
              return (
                <tr key={revision} data-current={revision === tip || undefined}>
                  <td>
                    <input
                      aria-label={`对比的旧版本：${revision}`}
                      checked={older === revision}
                      name="version-older"
                      onChange={() => setOlder(revision)}
                      type="radio"
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`对比的新版本：${revision}`}
                      checked={newer === revision}
                      name="version-newer"
                      onChange={() => setNewer(revision)}
                      type="radio"
                    />
                  </td>
                  <td>
                    修订号 {revision}
                    {index === 0 ? "（基线）" : ""}
                    {revision === tip ? "（当前）" : ""}
                  </td>
                  <td>{meta ? new Date(meta.at).toLocaleTimeString() : "—"}</td>
                  <td>
                    {revision !== tip ? (
                      <button className="action" onClick={() => restore(revision)} type="button">
                        <Undo2 aria-hidden="true" size={13} strokeWidth={1.75} />
                        恢复到此版本
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {diff ? (
          <pre className="version-diff">
            {diff.map((line, index) => (
              <span
                data-diff={line.kind}
                // biome-ignore lint/suspicious/noArrayIndexKey: 展示用的静态行列表
                key={index}
              >
                {line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  "}
                {line.text}
                {"\n"}
              </span>
            ))}
          </pre>
        ) : null}
      </div>
    </details>
  );
}

function markdownAt(
  schema: ReturnType<typeof buildSchema>,
  log: VersionLog,
  revision: number,
  editor: ReturnType<typeof useEditor>,
): string | null {
  const at = documentAtRevision(schema, log, revision);
  return at.ok ? documentToMarkdown(at.document, editor.getSchemaExtensions()) : null;
}

type DiffLine = { kind: "same" | "add" | "del"; text: string };

/** 教科书 LCS 行级 diff。版本对比是演示，不追求最短编辑脚本的花活。 */
function diffLines(before: string[], after: string[]): DiffLine[] {
  const rows = before.length;
  const cols = after.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let row = rows - 1; row >= 0; row -= 1) {
    const current = table[row];
    const below = table[row + 1];
    if (!current || !below) {
      continue;
    }
    for (let col = cols - 1; col >= 0; col -= 1) {
      current[col] =
        before[row] === after[col]
          ? (below[col + 1] ?? 0) + 1
          : Math.max(below[col] ?? 0, current[col + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (before[row] === after[col]) {
      lines.push({ kind: "same", text: before[row] ?? "" });
      row += 1;
      col += 1;
    } else if ((table[row + 1]?.[col] ?? 0) >= (table[row]?.[col + 1] ?? 0)) {
      lines.push({ kind: "del", text: before[row] ?? "" });
      row += 1;
    } else {
      lines.push({ kind: "add", text: after[col] ?? "" });
      col += 1;
    }
  }
  while (row < rows) {
    lines.push({ kind: "del", text: before[row] ?? "" });
    row += 1;
  }
  while (col < cols) {
    lines.push({ kind: "add", text: after[col] ?? "" });
    col += 1;
  }
  return lines;
}
