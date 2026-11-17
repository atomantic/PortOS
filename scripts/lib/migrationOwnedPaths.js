/**
 * `data/` paths that a MIGRATION derives from an install's existing records, and that must therefore ship no `data.reference/` seed. The sibling test checks migration OWNED_OUTPUT_PATHS declarations against this set and enforces every
 * seed's ABSENCE; the seed filter below (used by `scripts/setup-data.js` and `scripts/smoke-boot.js`) is defense in depth. Rationale and the silent data loss a seed causes: `scripts/migrations/340-cos-config-seed-repair.js`.
 */
import { join } from 'path';

/** Paths relative to `data/` (and to `data.reference/`), always posix-spelled. */
export const MIGRATION_OWNED_PATHS = new Set([
  'private/api-keys.json', // Derived from legacy integration settings; never seeded.
  'eidoverse/portos-world.json', // Per-install state and explicit aliases; never seed over it.
  // Migration 339 lifts the durable CoS config out of data/cos/state.json (absent, `loadConfig()` returns DEFAULT_CONFIG).
  'cos/config.json',
  // Migration 358 parks an untouched pre-graph copy of the install's data/providers.json before the connection graph (#6367) writes to it; a shipped seed would masquerade as their pre-graph configuration and destroy recovery.
  'private/providers.pre-graph.json',
  // Migration 359 rewrites the install's burn plan into scheduled-task references and parks the pre-conversion copy beside it; a shipped seed (setup-data runs first) would be converted in place of their plan and masquerade as the recovery copy.
  'cos/quota-burn.json',
  'cos/quota-burn.pre-359.json',
  // Migration 370 preserves this install's managed Tailcat serve consent/key; 451 folds the old peer-media-holdings.json into this record (#14141).
  'media-holders.json',
  'tailcat-serve.json',
  // Migration 397 re-binds this install's Eidoverse foundations to body-derived assay evidence (#7625); every record is the user's own work, and a shipped seed would land first and be rewritten in place of their ledger.
  'eidoverse/foundations.json',
  // Migration 425 retains completed-delivery history in the install-local store.
  'eidoverse/controllers.json',
  // Migration 406 derives the CoS archive's completion-order projection from the install's agent metadata; a shipped seed (setup-data runs before migrations) would be merged with another machine's runs.
  'cos/agents/index.order.json',
  // Migration 412 prunes memory-classifier-config.json and browser-config.json of keys equal to the shipped seed values; a shipped seed would shadow environment-derived defaults (LM_STUDIO_URL, CDP_HOST).
  'memory-classifier-config.json',
  'browser-config.json',
  // Migration 450 stamps the origin machine on this install's own video rows
  // and gallery image sidecars; a seed would be stamped as media made here.
  'video-history.json',
  'images',
  // Migration 457 backfills stable ids onto this install's own Life Calendar
  // activities; with no file the service serves code defaults with fixed ids.
  'meatspace/activities.json',
]);

/**
 * `data.reference/` files that describe the shipped tree rather than seed an install: `prompts/shipped-hashes.json` is read in place by the prompt reconciler.
 */
export const REFERENCE_ONLY_PATHS = new Set([
  'prompts/shipped-hashes.json',
]);

/**
 * A `cpSync` filter for seeding `data/` from `referenceDir`: true for every
 * source path except a migration-owned or reference-only one.
 * @param {string} referenceDir absolute path to the `data.reference/` being copied
 * @returns {(srcPath: string) => boolean}
 */
export function isSeedableReferencePath(referenceDir) {
  const owned = new Set([...MIGRATION_OWNED_PATHS, ...REFERENCE_ONLY_PATHS].map((relPath) => join(referenceDir, ...relPath.split('/'))));
  return (srcPath) => !owned.has(srcPath);
}
