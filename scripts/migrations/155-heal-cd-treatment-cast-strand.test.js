import { describe, it, expect } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './155-heal-cd-treatment-cast-strand.js';

describe('migration 155 - heal cd-treatment catalog-cast strand', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-155-',
  });

  it('tracks the exact #2042 strand hash (148-partial) as auto-updatable', () => {
    // md5 `95b76856…` is the deterministic output of migration 148 applied to
    // the older pre-#1808 shipped template (`2ffa482e…`, pre-imageStrength-knob):
    // insertion 1 lands the Cast list, insertion 2's scene anchor misses. That
    // stranded shape must be in the accepted-old set or the fix is a no-op.
    expect(ACCEPTED_OLD_MD5['cd-treatment.md']).toContain('95b7685690ecfee4f682b0293b790277');
    // Both pristine pre-#1808 shipped versions upgrade too.
    expect(ACCEPTED_OLD_MD5['cd-treatment.md']).toContain('2ffa482e7bfb6fe8b7224505fedbf712');
    expect(ACCEPTED_OLD_MD5['cd-treatment.md']).toContain('16d0ef6a7fd2533719a846019122ebee');
    // Current shipped hash must never appear in its own accepted-old set.
    expect(ACCEPTED_OLD_MD5['cd-treatment.md']).not.toContain(NEW_SHIPPED_MD5['cd-treatment.md']);
  });
});
