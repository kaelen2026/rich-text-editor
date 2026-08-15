# Clipboard fixtures

每个 `*.dump.json` 保存一次复制时拿到的全部 MIME 数据，配套的 `*.golden.json` 是
编辑器应还原出的 `Slice.toJSON()`。执行 `pnpm vitest run packages/editor-pm-adapter/src/clipboard.test.ts`
会跑自产内部复制的 golden diff；S9 会在此目录新增 Word、Excel、网页、飞书、Notion、公众号和
Google Docs 的原始 dump。

重录内部样本时，在 playground 中选中两段文本，复制后将 DevTools 里 `text/html`、`text/plain` 和
`application/x-company-editor+json` 三项写入新的 dump，并以 `parseSlice(...).toJSON()` 更新 golden。
