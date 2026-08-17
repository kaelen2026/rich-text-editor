# Clipboard fixtures

每个 `*.dump.json` 保存一次复制时拿到的全部 MIME 数据，配套的 `*.golden.json` 是
编辑器应还原出的 `Slice.toJSON()`。`word`、`excel`、`web`、`web-container`、`feishu`、`notion`、
`wechat` 和 `google-docs` 各保存一份完整 MIME dump。Excel HTML 的 `StartFragment` 与 Word 的
`file:` 图片样本都保留在原始 dump 中，避免来源规则在后续改动时悄然退化。

## 加样本时想一想它覆盖了哪条路径

`web-container` 是后补的，值得说说它为什么后补。原先七份样本的 HTML 都是裸的
`<h2><p>`，而真实网页复制出来的内容几乎总是裹着 `div` / `section` / `figure`。于是
"容器把内部块结构压平成一个段落"这条缺陷在整个语料库里**没有一处走得到**，golden
全绿地放它过去了很久，直到 S25 在真实浏览器里粘了一次才暴露出来。

语料库的价值不在于份数，在于覆盖的解析路径。加样本时先问一句：它会走到哪条别的
样本走不到的分支？如果答不上来，加它只是让测试变慢。

跑 golden diff：

```sh
pnpm exec vitest run packages/editor-pm-adapter/src/clipboard-sources.test.ts
```

重录内部样本时，在 playground 中选中两段文本，复制后将 DevTools 里 `text/html`、`text/plain` 和
`application/x-company-editor+json` 三项写入新的 dump，并以 `parseSlice(...).toJSON()` 更新 golden。
