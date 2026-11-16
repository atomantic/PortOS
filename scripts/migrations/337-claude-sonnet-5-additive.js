/**
 * Offer `claude-sonnet-5` on a Claude CLI/TUI record that still lists only the retired `claude-sonnet-4-6` sonnet tier.
 *
 * Migration 153 made this swap only for a `models` array matching the prior seeded trio exactly, so a user who had appended an id (a Fable tier, say) was classified "customized" and kept the 4-6 tier; `claude` has no `models` subcommand,
 * so nothing refreshes that record and the pickers can't offer the current sonnet. Built on `makeAdditiveProviderInsertMigration` (`_lib.js` family 7b): ADDITIVE, deliberately the opposite of 153/206 and `makeSeededProviderTierMigration`, because it runs against curated lists.
 * `claude-sonnet-5` is INSERTED right after `claude-sonnet-4-6` and the retired id is KEPT (it still resolves for the CLI, so dropping it would remove a working pin). Tier pointers (`defaultModel`/`lightModel`/`mediumModel`/`heavyModel`) are left ALONE: re-pointing a curated list overrides a deliberate choice.
 * Idempotent: a record already listing `claude-sonnet-5` is untouched (a no-op on a seeded install and on a second run).
 */

import { makeAdditiveProviderInsertMigration } from './_lib.js';

// The four seeded Claude records and the sonnet id each spells; the Bedrock pair uses the region-qualified form its environment resolves (a bare `claude-sonnet-5` there would offer an id it can't run).
export const TARGETS = [
  { id: 'claude-code', retired: 'claude-sonnet-4-6', current: 'claude-sonnet-5' },
  { id: 'claude-code-tui', retired: 'claude-sonnet-4-6', current: 'claude-sonnet-5' },
  { id: 'claude-code-bedrock', retired: 'us.anthropic.claude-sonnet-4-6', current: 'us.anthropic.claude-sonnet-5' },
  { id: 'claude-code-tui-bedrock', retired: 'us.anthropic.claude-sonnet-4-6', current: 'us.anthropic.claude-sonnet-5' },
];

export default makeAdditiveProviderInsertMigration({ targets: TARGETS, label: 'claude-sonnet-5' });
