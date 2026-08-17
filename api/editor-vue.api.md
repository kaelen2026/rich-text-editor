# editor-vue

```ts
EditorContent: import("vue/dist/vue").DefineComponent<import("vue/dist/vue").ExtractPropTypes<{ className: { type: StringConstructor; default: undefined; }; ariaLabel: { type: StringConstructor; default: string; }; }>, () => import("vue/dist/vue").VNode<import("vue/dist/vue").RendererNode, import("vue/dist/vue").RendererElement, { [key: string]: any; }>, {}, {}, {}, import("vue/dist/vue").ComponentOptionsMixin, import("vue/dist/vue").ComponentOptionsMixin, {}, string, import("vue/dist/vue").PublicProps, Readonly<import("vue/dist/vue").ExtractPropTypes<{ className: { type: StringConstructor; default: undefined; }; ariaLabel: { type: StringConstructor; default: string; }; }>> & Readonly<{}>, { className: string; ariaLabel: string; }, {}, {}, {}, string, import("vue/dist/vue").ComponentProvideOptions, true, {}, any>
```

```ts
editorKey: InjectionKey<RichEditor>
```

```ts
EditorProvider: import("vue/dist/vue").DefineComponent<import("vue/dist/vue").ExtractPropTypes<{ editor: { type: PropType<RichEditor>; required: true; }; }>, () => import("vue/dist/vue").VNode<import("vue/dist/vue").RendererNode, import("vue/dist/vue").RendererElement, { [key: string]: any; }>[] | undefined, {}, {}, {}, import("vue/dist/vue").ComponentOptionsMixin, import("vue/dist/vue").ComponentOptionsMixin, {}, string, import("vue/dist/vue").PublicProps, Readonly<import("vue/dist/vue").ExtractPropTypes<{ editor: { type: PropType<RichEditor>; required: true; }; }>> & Readonly<{}>, {}, {}, {}, {}, string, import("vue/dist/vue").ComponentProvideOptions, true, {}, any>
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
