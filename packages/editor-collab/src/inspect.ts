import * as Y from "yjs";

/** 共享文档里用到的持久化名字，按首次出现顺序去重。 */
export interface SharedDocumentNames {
  nodes: string[];
  marks: string[];
}

/**
 * 扫描共享片段，收集它用到的节点名与标记名。
 *
 * 这是协同兼容闸门的输入。判据必须取自**共享文档本身**而不是信封的 `plugins`
 * 字段：协作文档没有信封，它的事实来源是 Y.Doc；而且新节点可能是某个协作者
 * 刚刚插进来的，任何静态声明都会落后于它。
 */
export function collectSharedNames(fragment: Y.XmlFragment): SharedDocumentNames {
  const nodes: string[] = [];
  const marks: string[] = [];
  const seenNodes = new Set<string>();
  const seenMarks = new Set<string>();

  const visitText = (text: Y.XmlText): void => {
    for (const segment of text.toDelta() as Array<{ attributes?: Record<string, unknown> }>) {
      for (const name of Object.keys(segment.attributes ?? {})) {
        if (!seenMarks.has(name)) {
          seenMarks.add(name);
          marks.push(name);
        }
      }
    }
  };

  const visit = (type: Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment): void => {
    if (type instanceof Y.XmlText) {
      visitText(type);
      return;
    }
    if (type instanceof Y.XmlElement) {
      if (!seenNodes.has(type.nodeName)) {
        seenNodes.add(type.nodeName);
        nodes.push(type.nodeName);
      }
    }
    if (type instanceof Y.XmlElement || type instanceof Y.XmlFragment) {
      for (const child of type.toArray()) {
        visit(child);
      }
    }
  };

  visit(fragment);
  return { nodes, marks };
}
