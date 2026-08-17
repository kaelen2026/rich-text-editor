# editor-schema

```ts
assertMigrationsDeclareReversibility: (migrations: DocumentMigration[]) => void
```

```ts
BLOCK_ALIGNMENTS: readonly ["left", "center", "right", "justify"]
```

```ts
type BlockAlign = (typeof BLOCK_ALIGNMENTS)[number];
```

```ts
cloneJson: <T>(value: T) => T
```

```ts
coreMarks: Record<string, CoreMarkSpec>
```

```ts
coreNodes: Record<string, CoreNodeSpec>
```

```ts
countDocumentText: (document: EditorEnvelope | NodeJSON) => DocumentTextStats
```

```ts
countText: (text: string) => DocumentTextStats
```

```ts
createEmptyEnvelope: () => EditorEnvelope
```

```ts
documentToMarkdown: (document: EditorEnvelope | NodeJSON, extensions?: RenderSchema) => string
```

```ts
ENVELOPE_VERSION: 1
```

```ts
escapeBlockText: (text: string) => string
```

```ts
escapeInline: (text: string) => string
```

```ts
escapeLinkDestination: (url: string) => string
```

```ts
flattenTableCell: (text: string) => string
```

```ts
type HeadingLevel = 1 | 2 | 3 | 4;
```

```ts
isBlockAlign: (value: unknown) => value is BlockAlign
```

```ts
isCodeLanguage: (value: unknown) => value is string
```

```ts
isHeadingLevel: (value: unknown) => value is HeadingLevel
```

```ts
MAX_HEADING_LEVEL: 4
```

```ts
migrateEnvelope: (input: EditorEnvelope | NodeJSON, migrations?: DocumentMigration[]) => MigrateResult
```

```ts
type MigrateResult =
  | { ok: true; envelope: EditorEnvelope; migrated: boolean }
  | { ok: false; errors: string[] };
```

```ts
prefixLines: (text: string, firstPrefix: string, restPrefix?: string) => string
```

```ts
renderDocumentToHTML: (document: EditorEnvelope | NodeJSON, extensions?: RenderSchema) => string
```

```ts
interface RenderSchema {
  nodes?: Record<string, CoreNodeSpec>;
  marks?: Record<string, CoreMarkSpec>;
}
```

```ts
SCHEMA_VERSION: 1
```

```ts
stringifyEnvelope: (envelope: EditorEnvelope) => string
```

```ts
targetVersion: (migrations: DocumentMigration[]) => number
```

```ts
UNKNOWN_BLOCK: "unknown_block"
```

```ts
UNKNOWN_INLINE: "unknown_inline"
```

```ts
validateEnvelope: (value: unknown) => string[]
```
