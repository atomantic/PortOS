/**
 * Offer `claude-sonnet-5` on a Claude CLI/TUI record that still lists only the
 * retired `claude-sonnet-4-6` sonnet tier.
 *
 * Migration 153 already made this swap, but ONLY for a `models` array matching
 * the prior seeded trio exactly — a user who had appended an id to the list (a
 * Fable tier, say) was classified as "customized" and skipped, and their record
 * kept the 4-6 tier while the shipped seed and their other Claude records moved
 * on. `claude` has no `models` subcommand, so nothing in the app can refresh
 * that record: the reviewer/task model pickers reading it offer the retired
 * sonnet and cannot offer the current one at all.
 *
 * Built on `makeAdditiveProviderInsertMigration` (`_lib.js` family 7b) —
 * ADDITIVE, deliberately the opposite policy from 153/206 and from
 * `makeSeededProviderTierMigration` (family 7), because this one runs against
 * lists the user curated:
 *
 *   - `claude-sonnet-5` is INSERTED right after `claude-sonnet-4-6`, and the
 *     retired id is KEPT. `claude-sonnet-4-6` still resolves for the CLI, so
 *     dropping an id a user chose to list would remove a working pin; the defect
 *     is the new tier being absent, not the old one being present.
 *   - Tier pointers (`defaultModel`/`lightModel`/`mediumModel`/`heavyModel`) are
 *     left ALONE. They point at an id that still works, and a curated list is
 *     exactly where re-pointing would override a deliberate choice.
 *
 * Idempotent by the same condition either way: a record already listing
 * `claude-sonnet-5` is untouched, so this is a no-op on a seeded install (153/206
 * or a fresh `data.reference` seed already put it there) and on a second run.
 */

import { makeAdditiveProviderInsertMigration } from './_lib.js';

// The four seeded Claude records and the sonnet id each one spells. The Bedrock
// pair uses the region-qualified form its own environment resolves — inserting a
// bare `claude-sonnet-5` there would offer an id that record cannot run.
export const TARGETS = [
  { id: 'claude-code', retired: 'claude-sonnet-4-6', current: 'claude-sonnet-5' },
  { id: 'claude-code-tui', retired: 'claude-sonnet-4-6', current: 'claude-sonnet-5' },
  { id: 'claude-code-bedrock', retired: 'us.anthropic.claude-sonnet-4-6', current: 'us.anthropic.claude-sonnet-5' },
  { id: 'claude-code-tui-bedrock', retired: 'us.anthropic.claude-sonnet-4-6', current: 'us.anthropic.claude-sonnet-5' },
];

export default makeAdditiveProviderInsertMigration({ targets: TARGETS, label: 'claude-sonnet-5' });
