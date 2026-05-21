/**
 * Test for migration 003 — pipeline stage prompts gain {{lengthTargets.*}}
 * variables.
 *
 * `pipeline-tv-script.md` was retired (renamed to `pipeline-teleplay.md`) so
 * it has no `data.sample/` counterpart; the standard fixture loop in
 * `_testHelpers.js` reads the live sample to seed each fixture, which would
 * ENOENT on the retired entry. Filter it out of the test-facing maps — the
 * retire-on-missing branch is exercised end-to-end by `scripts/run-migrations.js`
 * on every fresh install, not by this drift-catch suite.
 *
 * Picked up via the vitest include glob in server/vitest.config.js
 * (`../scripts/**\/*.test.js`).
 */
import { describe } from 'vitest';

import { runPromptMigrationTests } from './_testHelpers.js';
import migration, { applyMigration, ACCEPTED_OLD_MD5, NEW_SHIPPED_MD5 } from './003-update-pipeline-stage-prompts.js';

const RETIRED = 'pipeline-tv-script.md';
const { [RETIRED]: _retiredAccepted, ...ACTIVE_ACCEPTED } = ACCEPTED_OLD_MD5;
const { [RETIRED]: _retiredNew, ...ACTIVE_NEW } = NEW_SHIPPED_MD5;

describe('migration 003 — pipeline stage prompts (length profile)', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5: ACTIVE_ACCEPTED,
    NEW_SHIPPED_MD5: ACTIVE_NEW,
    prefix: 'migration-003-',
  });
});
