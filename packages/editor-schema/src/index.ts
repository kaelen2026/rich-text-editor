export { coreMarks, coreNodes, UNKNOWN_BLOCK, UNKNOWN_INLINE } from "./core-spec";
export {
  createEmptyEnvelope,
  ENVELOPE_VERSION,
  type MigrationResult,
  migrateDocument,
  SCHEMA_VERSION,
  type SchemaMigration,
  schemaMigrations,
  stringifyEnvelope,
  validateEnvelope,
} from "./envelope";
