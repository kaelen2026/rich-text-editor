# editor-react-ui

```ts
EditorToolbar: ({ definition, className, renderMenu, renderLabel, nativeTooltip, onExecute, }: EditorToolbarProps) => import("@types/react/index").JSX.Element
```

```ts
interface EditorToolbarProps {
  definition: ToolbarDefinition;
  className?: string;
  /** Render a menu's contents. Escape always returns focus to its trigger. */
  renderMenu?: (item: ToolbarItemState, close: () => void) => ReactNode;
  /**
   * Replace a button's visible content, for example with an icon. The accessible
   * name stays `item.label`, so icon-only toolbars keep their screen reader text.
   */
  renderLabel?: (item: ToolbarItemState) => ReactNode;
  /**
   * Set to false when the host draws its own tooltip. The native `title` tooltip would
   * otherwise appear on top of it a second later. The accessible name is unaffected.
   */
  nativeTooltip?: boolean;
  /** Allows hosts to supply a native file picker or another non-command action. */
  onExecute?: (item: ToolbarItemState) => boolean | undefined;
}
```
