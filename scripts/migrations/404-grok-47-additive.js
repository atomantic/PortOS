/** Offer Grok 4.7 without replacing working model selections or custom args. */
import { makeAdditiveProviderInsertMigration } from './_lib.js';

export const TARGETS = [
  { id: 'grok-cli', retired: 'grok-4.6', current: 'grok-4.7' },
  { id: 'grok-tui', retired: 'grok-4.6', current: 'grok-4.7' },
  { id: 'grok', retired: 'grok-4', current: 'grok-4.7' },
];

export default makeAdditiveProviderInsertMigration({ targets: TARGETS, label: 'grok-4.7' });
