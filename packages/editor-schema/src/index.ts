export { cloneJson } from "./clone";
export {
  coreMarks,
  coreNodes,
  type HeadingLevel,
  isHeadingLevel,
  MAX_HEADING_LEVEL,
  UNKNOWN_BLOCK,
  UNKNOWN_INLINE,
} from "./core-spec";
export {
  createEmptyEnvelope,
  ENVELOPE_VERSION,
  SCHEMA_VERSION,
  stringifyEnvelope,
  validateEnvelope,
} from "./envelope";
export {
  assertMigrationsDeclareReversibility,
  type MigrateResult,
  migrateEnvelope,
  targetVersion,
} from "./migrate";
