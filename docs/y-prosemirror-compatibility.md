# y-prosemirror 兼容性 PoC

## 结论

**通过（有接入边界）。** `y-prosemirror@1.3.7` 可与当前 ProseMirror 依赖组合
（`prosemirror-model@1.25.11`、`prosemirror-state@1.4.4`、`prosemirror-view@1.42.2`）
协作。它不会限制 Schema 的节点名或结构：本 PoC 的 `co_table` / `co_table_row` /
`co_table_cell` 结构在两个连接同一 `Y.XmlFragment` 的 `EditorView` 之间无损同步。

自定义 NodeView 也兼容：远端对 `co_widget` 属性的更改会成为普通 ProseMirror
transaction，并调用接收端 NodeView 的 `update`。因此，M4 将历史实现从
`prosemirror-history` 换为 `Y.UndoManager` 时，协同接入仍可限制在
`editor-pm-adapter`；业务 API、平台 Schema 和框架桥不需要因此改变。

## 可复现验证

测试在 `packages/editor-pm-adapter/src/y-prosemirror-compat.test.ts`，使用真实
`Y.Doc`、`Y.XmlFragment` 与 `ySyncPlugin`，覆盖：

- 初始化后的 `co_table` 结构在第二个视图中完整恢复；
- 在一个视图改写表格单元格，另一个视图保留表格层级与其他单元格并收到改动；
- 在一个视图更新原子 `co_widget` 的属性，另一个视图的自定义 NodeView 更新其 DOM。

运行：

```sh
pnpm exec vitest run packages/editor-pm-adapter/src/y-prosemirror-compat.test.ts
```

## 缺插件的客户端会破坏共享文档（S28 实测）

PoC 当时只说"未验证"。实现 S28 时把它验了，结论比预估严重：

- `createNodeFromYElement` 在 `schema.node()` 抛错时进 `catch`，**把那个 Y 元素从
  共享文档里删掉**。缺插件的客户端不是"打不开"，是替所有人删内容。
- `createTextNodesFromYText` 同理，未知**标记**会让整个 `Y.XmlText` 被删——丢的是
  文字本身，不是格式。单机装载时 §9.3 承诺的"丢标记保文本"在协同下不成立。

两条都钉在 `packages/editor-pm-adapter/src/y-prosemirror-compat.test.ts` 里，是可
执行的证据而不是描述。

因此 S28 的兼容判断放在**更新写进 `Y.Doc` 之前**：读 update 字节里的节点名与标记名
（`collectUpdateNames`），本端 Schema 不认识就整条不应用，随后退出协作并上报
`collabRejected`。这是唯一 race-free 的位置——等 y-prosemirror 解码完再检查，内容
已经没了。同一套机制既管接入时，也管接入之后别的协作者新插进来的未知节点。

初始化持久化文档时，应仅在第一个编辑器连接前把平台 JSON 导入共享片段：

```ts
prosemirrorJSONToYXmlFragment(schema, documentJson, ydoc.getXmlFragment("prosemirror"))
```

随后每个视图使用同一个片段配置 `ySyncPlugin(fragment)`。同一协作文档的所有参与者
必须安装兼容的 Schema——这条现在由 `CollabBinding` 强制执行，不再是一条只写在文档
里的约定。

**降级不成立，只能拒绝。** `unknown_*` 兜底在协同下没有对应物：兜底的前提是"本端把
未知结构原样留着"，而 Yjs 的写回是按节点名做结构 diff 的，一个渲染成 `unknown_block`
的 `co_table` 会在下一次本地编辑时被写回成 `unknown_block`——那才是真正不可逆的破坏。
因此 S28 的立场是"不兼容就不接入"，而不是"接入后降级显示"。

## 接入约束与后续工作

- NodeView 是本地视图层，不进入 Yjs 文档。其 `update` 必须能根据同步后的节点重绘，
  临时 UI 状态（焦点、悬浮、上传进度）必须留在插件 state 或宿主状态，不能藏在 DOM。
- 本 PoC 验证了嵌套表格结构和原子自定义 NodeView；真实表格的 `colspan` / `rowspan` 与表格
  命令已上线，后续若引入图片 NodeView，应将这些真实插件节点加入同一测试矩阵。当前图片上传
  使用 Decoration，不依赖 NodeView。
- 生产接入需要在 `editor-pm-adapter` 增加显式协同会话配置：安装 `ySyncPlugin`，并将
  `recordHistory` 的实现切换到 Yjs 的 UndoManager。不要让业务层直接接触
  `EditorState`、Yjs transaction 或历史 meta。
- 此测试使用内存 Yjs 文档和 jsdom。断连重连、awareness、两个真实浏览器的并发编辑与
  中文 IME 期间的远端 transaction，已在 S28 由 `e2e/collab.spec.ts` 在真实浏览器里覆盖。
- **y-prosemirror 全文没有一处组合态处理**（`grep -rn composing` 零命中）。远端更新一到
  就整篇重建 DOM，正在被输入法接管的那段字随即消失。S28 的做法是把入站更新挡在 Yjs
  这一层（`CollabProvider.setInboundPaused`），而不是到会话的挂起队列里重放 ySync 的
  step——那些 step 是"整篇替换"，重映射它没有意义。
- **撤销要用 `undoCommand` / `redoCommand`，不是同包的 `undo` / `redo`。** 后者无视
  `dispatch`，一调用就真的撤销；而工具栏每渲染一帧都会用 `dispatch == null` 的试跑去问
  可用性，用错等于每帧撤销一次。
