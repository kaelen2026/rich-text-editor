# editor-vue

```ts
EditorContent: import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").DefineComponent<import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ExtractPropTypes<{ className: { type: StringConstructor; default: undefined; }; ariaLabel: { type: StringConstructor; default: string; }; }>, () => import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").VNode<import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").RendererNode, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").RendererElement, { [key: string]: any; }>, {}, {}, {}, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ComponentOptionsMixin, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ComponentOptionsMixin, {}, string, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").PublicProps, Readonly<import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ExtractPropTypes<{ className: { type: StringConstructor; default: undefined; }; ariaLabel: { type: StringConstructor; default: string; }; }>> & Readonly<{}>, { className: string; ariaLabel: string; }, {}, {}, {}, string, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ComponentProvideOptions, true, {}, any>
```

```ts
editorKey: InjectionKey<RichEditor>
```

```ts
EditorProvider: import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").DefineComponent<import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ExtractPropTypes<{ editor: { type: PropType<RichEditor>; required: true; }; }>, () => import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").VNode<import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").RendererNode, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").RendererElement, { [key: string]: any; }>[] | undefined, {}, {}, {}, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ComponentOptionsMixin, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ComponentOptionsMixin, {}, string, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").PublicProps, Readonly<import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ExtractPropTypes<{ editor: { type: PropType<RichEditor>; required: true; }; }>> & Readonly<{}>, {}, {}, {}, {}, string, import("/Users/kaelen/workspace/github/kaelen2026/rich-text-editor/.claude/worktrees/remaining-debts/node_modules/.pnpm/vue@3.5.41_typescript@5.9.3/node_modules/vue/dist/vue").ComponentProvideOptions, true, {}, any>
```

```ts
provideEditor: (editor: RichEditor) => void
```

```ts
useCommandQuery: (command: string, input?: unknown) => ComputedRef<CommandQuery>
```

```ts
useEditor: () => RichEditor
```

```ts
useEditorSelector: <TSelected>(selector: (snapshot: EditorSnapshot) => TSelected) => ComputedRef<TSelected>
```

```ts
useEditorSnapshot: () => Readonly<ShallowRef<EditorSnapshot>>
```

```ts
usePluginErrors: () => Readonly<ShallowRef<readonly PluginError[]>>
```
