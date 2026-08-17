import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';

import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import migration, {
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  applyMigration,
} from './275-pipeline-planning-economy.js';

describe('migration 275 — pipeline planning economy', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-275-pipeline-planning-economy-',
  });

  it('publishes the episode budget and dramatic-economy checks', () => {
    const read = (name) => readFileSync(
      `${repoRoot}/data.reference/prompts/stages/${name}`,
      'utf8',
    );
    const resolver = read('pipeline-arc-resolve.md');
    const arcVerify = read('pipeline-arc-verify.md');
    const volumeVerify = read('pipeline-volume-verify.md');

    expect(resolver).toContain('episode synopsis 4,000');
    expect(resolver).toContain('replace or compact conflicting language');
    for (const prompt of [arcVerify, volumeVerify]) {
      expect(prompt).toContain('Dramatic economy');
      expect(prompt).toContain('Planning altitude and metadata fit');
      expect(prompt).toMatch(/goal, obstacle,[\s\S]*consequential choice/);
    }
    expect(arcVerify).toContain('Premise-engine continuity');
    expect(volumeVerify).toContain('Active story engines');
  });
});
