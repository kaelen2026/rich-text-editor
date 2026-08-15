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

初始化持久化文档时，应仅在第一个编辑器连接前把平台 JSON 导入共享片段：

```ts
prosemirrorJSONToYXmlFragment(schema, documentJson, ydoc.getXmlFragment("prosemirror"))
```

随后每个视图使用同一个片段配置 `ySyncPlugin(fragment)`。同一协作文档的所有参与者
必须安装兼容的 Schema；当前 `unknown_*` 兜底只覆盖平台 JSON 装载，尚未验证对
`Y.XmlFragment` 的未知节点降级。因此，缺少表格或自定义节点的客户端在 M4 前不得加入
该协作文档；若要支持该场景，需先实现并验证专用的 Yjs 解码降级层，且绝不能把未知结构
写回为其他结构。

## 接入约束与后续工作

- NodeView 是本地视图层，不进入 Yjs 文档。其 `update` 必须能根据同步后的节点重绘，
  临时 UI 状态（焦点、悬浮、上传进度）必须留在插件 state 或宿主状态，不能藏在 DOM。
- 本 PoC 验证了嵌套表格结构和原子自定义 NodeView；S10 的 `colspan` / `rowspan`、表格
  命令及 S11 的图片 NodeView 上线后，应将真实插件节点加入同一测试矩阵。
- 生产接入需要在 `editor-pm-adapter` 增加显式协同会话配置：安装 `ySyncPlugin`，并将
  `recordHistory` 的实现切换到 Yjs 的 UndoManager。不要让业务层直接接触
  `EditorState`、Yjs transaction 或历史 meta。
- 此测试使用内存 Yjs 文档和 jsdom，不覆盖 provider 断连重连、awareness、两个真实浏览器
  的并发编辑，或中文 IME 期间远端 transaction 排队；这些是 M4 前应补的浏览器端验证。
