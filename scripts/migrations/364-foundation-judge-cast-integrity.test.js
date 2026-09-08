import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './364-foundation-judge-cast-integrity.js';

describe('migration 364 — foundation judge cast integrity', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-364-foundation-judge-cast-integrity-',
  });

  it('makes the depth rulings binding and separates filled fields from integrity', () => {
    const judge = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/pipeline-judge-foundation.md`,
      'utf8',
    );
    // The variable the judge context now supplies — without it the section
    // renders as literal mustache and the rulings say nothing.
    expect(judge).toContain('{{castIntegrity}}');
    expect(judge).toContain('binding on your `character` score');
    // The three depths must each be named, or the judge cannot act on a ruling
    // it is told to obey.
    for (const depth of ['explained', 'light', 'full']) {
      expect(judge).toContain(`\`${depth}\``);
    }
    // The two halves of the issue's contract: no manufactured trauma, and
    // all-fields-filled is not integrity.
    expect(judge).toContain('A filled field is not integrity');
    expect(judge).toContain('manufacture damage to fill a slot');
  });
});
