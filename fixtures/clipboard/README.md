# Clipboard fixtures

每个 `*.dump.json` 保存一次复制时拿到的全部 MIME 数据，配套的 `*.golden.json` 是
编辑器应还原出的 `Slice.toJSON()`。执行 `pnpm vitest run packages/editor-pm-adapter/src/clipboard.test.ts`
`word`、`excel`、`web`、`feishu`、`notion`、`wechat` 和 `google-docs` 保存各来源的完整 MIME dump；
`clipboard-sources.test.ts` 会对所有来源运行 golden diff。Excel HTML 的 `StartFragment` 与 Word 的
`file:` 图片样本都保留在原始 dump 中，避免来源规则在后续改动时悄然退化。

重录内部样本时，在 playground 中选中两段文本，复制后将 DevTools 里 `text/html`、`text/plain` 和
`application/x-company-editor+json` 三项写入新的 dump，并以 `parseSlice(...).toJSON()` 更新 golden。
