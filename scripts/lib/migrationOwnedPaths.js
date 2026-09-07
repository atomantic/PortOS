/**
 * `data/` paths that a MIGRATION derives from an install's existing records,
 * and that must therefore ship no `data.reference/` seed.
 *
 * The enforcement is the seed's ABSENCE, asserted by the sibling test. The
 * filter this list drives in `scripts/setup-data.js` (its one consumer) is
 * defense in depth for a seed someone re-adds. Full rationale — and the
 * silent data loss a seed causes here — is in
 * `scripts/migrations/340-cos-config-seed-repair.js`.
 */

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
]);
