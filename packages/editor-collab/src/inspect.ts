import * as Y from "yjs";

/** 共享文档里用到的持久化名字，按首次出现顺序去重。 */
export interface SharedDocumentNames {
  nodes: string[];
  marks: string[];
}

/** 按出现顺序去重的收集器。名字的顺序会进提示文案，稳定一点更好读。 */
class NameSet {
  private readonly seen = new Set<string>();
  readonly names: string[] = [];

  add(name: string): void {
    if (!this.seen.has(name)) {
      this.seen.add(name);
      this.names.push(name);
    }
  }
}

/**
 * 从一笔尚未应用的 Yjs 更新里读出它引入的节点名与标记名。
 *
 * 这是协同兼容判断的**唯一race-free 位置**。y-prosemirror 解码共享文档时，遇到
 * 本端 Schema 里没有的节点或标记，会在 `catch` 里把那个 Y 元素直接删掉——不是
 * 渲染失败，是替所有人删内容，而且标记那条删掉的是整段文字。等它解码完再检查
 * 已经晚了，因此判断必须发生在字节写进 Y.Doc 之前。
 *
 * 读的是更新的结构而不是文档：`ContentType` 携带节点（`YXmlElement.nodeName`），
 * `ContentFormat` 携带标记名。两者都不需要把更新应用到任何文档上。
 */
export function collectUpdateNames(update: Uint8Array): SharedDocumentNames {
  const nodes = new NameSet();
  const marks = new NameSet();
  for (const struct of Y.decodeUpdate(update).structs) {
    if (!(struct instanceof Y.Item)) {
      continue;
    }
    const content = struct.content;
    if (content instanceof Y.ContentFormat) {
      marks.add(content.key);
      continue;
    }
    if (content instanceof Y.ContentType) {
      const nodeName = (content.type as { nodeName?: unknown }).nodeName;
      // `YXmlText` 也是 ContentType，但它没有节点名——文本不是一种节点类型。
      if (typeof nodeName === "string") {
        nodes.add(nodeName);
      }
    }
  }
  return { nodes: nodes.names, marks: marks.names };
}

/**
 * 扫描共享片段，收集它用到的节点名与标记名。
 *
 * 这是协同兼容闸门的输入。判据必须取自**共享文档本身**而不是信封的 `plugins`
 * 字段：协作文档没有信封，它的事实来源是 Y.Doc；而且新节点可能是某个协作者
 * 刚刚插进来的，任何静态声明都会落后于它。
 */
export function collectSharedNames(fragment: Y.XmlFragment): SharedDocumentNames {
  const nodes = new NameSet();
  const marks = new NameSet();

  const visit = (type: Y.XmlElement | Y.XmlText | Y.XmlHook | Y.XmlFragment): void => {
    if (type instanceof Y.XmlText) {
      for (const segment of type.toDelta() as Array<{ attributes?: Record<string, unknown> }>) {
        for (const name of Object.keys(segment.attributes ?? {})) {
          marks.add(name);
        }
      }
      return;
    }
    if (type instanceof Y.XmlElement) {
      nodes.add(type.nodeName);
    }
    if (type instanceof Y.XmlElement || type instanceof Y.XmlFragment) {
      for (const child of type.toArray()) {
        visit(child);
      }
    }
  };

  visit(fragment);
  return { nodes: nodes.names, marks: marks.names };
}
