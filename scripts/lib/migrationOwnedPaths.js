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
  'eidoverse/portos-world.json', // Per-install state and explicit aliases; never seed over it.
  // Migration 339 lifts the durable CoS config out of data/cos/state.json.
  // Absent, `loadConfig()` in server/services/cosState.js returns DEFAULT_CONFIG.
  'cos/config.json',
]);
