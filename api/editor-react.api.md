# editor-react

```ts
EditorContent: ({ className, ariaLabel }: EditorContentProps) => import("@types/react/index").JSX.Element
```

```ts
EditorProvider: ({ editor, children }: EditorProviderProps) => import("@types/react/index").JSX.Element
```

```ts
useCommandQuery: (command: string, input?: unknown) => CommandQuery
```

```ts
useEditor: () => RichEditor
```

```ts
useEditorSelector: <TSelected>(selector: (snapshot: EditorSnapshot) => TSelected) => TSelected
```

```ts
useEditorSnapshot: () => EditorSnapshot
```

```ts
usePluginErrors: () => readonly PluginError[]
```
