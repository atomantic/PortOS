/**
 * `data/` paths that a MIGRATION derives from an install's existing records,
 * and that must therefore ship no `data.reference/` seed.
 *
 * The enforcement is the seed's ABSENCE, asserted by the sibling test. The
 * seed filter below — used by `scripts/setup-data.js` and the boot smoke's
 * disposable install (`scripts/smoke-boot.js`) — is defense in depth for a
 * seed someone re-adds. Full rationale — and the
 * silent data loss a seed causes here — is in
 * `scripts/migrations/340-cos-config-seed-repair.js`.
 */
import { join } from 'path';

/** Paths relative to `data/` (and to `data.reference/`), always posix-spelled. */
export const MIGRATION_OWNED_PATHS = new Set([
  'private/api-keys.json', // Derived from legacy integration settings; never seeded.
  'eidoverse/portos-world.json', // Per-install state and explicit aliases; never seed over it.
  // Migration 339 lifts the durable CoS config out of data/cos/state.json.
  // Absent, `loadConfig()` in server/services/cosState.js returns DEFAULT_CONFIG.
  'cos/config.json',
  // Migration 358 parks an untouched pre-graph copy of the install's own
  // data/providers.json before the provider connection graph (#6367) can write
  // to it. Derived from the user's records; a shipped seed would masquerade as
  // their pre-graph configuration and destroy the recovery path.
  'private/providers.pre-graph.json',
  // Migration 359 rewrites the install's own burn plan into scheduled-task
  // references, and parks the pre-conversion copy beside it. Both are derived
  // from the user's records; a shipped seed would be converted in place of
  // their plan (setup-data runs first) and would masquerade as the recovery
  // copy of a plan they never had.
  'cos/quota-burn.json',
  'cos/quota-burn.pre-359.json',
  // Migration 370 preserves this install's managed Tailcat serve consent/key.
  'tailcat-serve.json',
  // Migration 397 re-binds this install's own Eidoverse foundations to
  // body-derived assay evidence (#7625). Every record in it is the user's own
  // authored (or peer-inherited) work; a shipped seed would land first and the
  // migration would rewrite shipped defaults where their ledger should be.
  'eidoverse/foundations.json',
  // Migration 406 derives the CoS archive's completion-order projection from the
  // install's own agent metadata. A shipped seed would land first (setup-data
  // runs before migrations) and the backfill would then merge this install's
  // runs into another machine's rows.
  'cos/agents/index.order.json',
  // Migration 412 prunes memory-classifier-config.json and browser-config.json
  // to remove keys that equal the shipped seed values. Both files are derived
  // from user edits; a shipped seed would shadow environment-derived defaults
  // (LM_STUDIO_URL, CDP_HOST) and cause the service to ignore those env vars.
  'memory-classifier-config.json',
  'browser-config.json',
]);

/**
 * A `cpSync` filter for seeding `data/` from `referenceDir`: true for every
 * source path except a migration-owned one.
 *
 * @param {string} referenceDir absolute path to the `data.reference/` being copied
 * @returns {(srcPath: string) => boolean}
 */
export function isSeedableReferencePath(referenceDir) {
  const owned = new Set([...MIGRATION_OWNED_PATHS].map((relPath) => join(referenceDir, ...relPath.split('/'))));
  return (srcPath) => !owned.has(srcPath);
}
