import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './365-fableloom-editorial-cast-integrity.js';

describe('migration 365 — FableLoom editorial cast integrity', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-365-fableloom-editorial-cast-integrity-',
  });

  it('makes the depth rulings binding and keeps the editor off the character records', () => {
    const editor = readFileSync(
      `${repoRoot}/data.reference/prompts/stages/fableloom-editorial-remediate.md`,
      'utf8',
    );
    // The variable editorial.js now supplies — without it the section renders as
    // literal mustache and the rulings say nothing.
    expect(editor).toContain('{{castIntegrity}}');
    expect(editor).toContain('binding on your `character`');
    // Each depth has to be named, or the editor cannot act on a ruling it is
    // told to obey.
    for (const depth of ['explained', 'light', 'full']) {
      expect(editor).toContain(`\`${depth}\``);
    }
    // Both halves of the issue's contract.
    expect(editor).toContain('A filled field is not integrity');
    expect(editor).toContain('manufacture damage to fill a slot');
    // The boundary this surface adds: FableLoom patches the story, never canon.
    // Without it the editor's cheapest way to close a cast gap is to invent the
    // missing interior in scene prose, which is exactly what must not happen.
    expect(editor).toContain('Character records are not yours to patch');
  });
});
