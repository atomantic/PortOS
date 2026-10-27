/** Offer GPT-6.1 Terra alongside existing GPT-6 models without changing saved tiers. */
import { makeAdditiveProviderInsertMigration } from './_lib.js';

export const TARGETS = ['codex', 'codex-tui'].flatMap(id =>
  ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol'].map(retired => ({ id, retired, current: 'gpt-6.1-terra' }))
);

export default makeAdditiveProviderInsertMigration({ targets: TARGETS, label: 'GPT-6.1 Terra' });
