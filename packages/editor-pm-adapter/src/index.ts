export { coreCommands, type SessionCommand } from "./commands";
export {
  applyDocumentPatch,
  documentPatchFromTransaction,
  type PatchApplyResult,
  patchOpToSteps,
  stepToPatchOp,
} from "./document-patch";
export { buildSchema, type SchemaExtensions } from "./schema";
export {
  EditorSession,
  type ProtectedOutcome,
  type SelectionRange,
} from "./session";
export { restoreDoc, type SanitizeResult, sanitizeDoc } from "./unknown";
