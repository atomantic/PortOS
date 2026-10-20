import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runPromptMigrationTests, sampleBody, md5 } from './_testHelpers.js';
import migration, {
  applyMigration,
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
  DRIFT_SUBDIRS,
} from './431-security-audit-skill-trust-model.js';

const FILENAME = 'security-audit.md';

describe('migration 431 — security-audit skill trust model', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-431-',
    subdir: 'skills',
  });

  // The prompt-replace family defaults to prompts/stages/, so a missing
  // DRIFT_SUBDIRS entry would leave every install's skill untouched.
  it('upgrades the skill template, not a same-named stage prompt', async () => {
    expect(DRIFT_SUBDIRS[FILENAME]).toBe('skills');
    const rootDir = mkdtempSync(join(tmpdir(), 'migration-431-routing-'));
    const skillsDir = join(rootDir, 'data', 'prompts', 'skills');
    const stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    const sampleDir = join(rootDir, 'data.reference', 'prompts', 'skills');
    for (const dir of [skillsDir, stagesDir, sampleDir]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(sampleDir, FILENAME), sampleBody(FILENAME, 'skills'));
    const staleBody = '# synthetic pre-#9875 skill\n';
    writeFileSync(join(skillsDir, FILENAME), staleBody);
    writeFileSync(join(stagesDir, FILENAME), staleBody);

    const result = await applyMigration({
      rootDir,
      accepted: { [FILENAME]: [md5(staleBody)] },
      current: { [FILENAME]: md5(sampleBody(FILENAME, 'skills')) },
    });

    expect(result).toMatchObject({ updated: 1, skipped: 0 });
    expect(readFileSync(join(skillsDir, FILENAME), 'utf-8')).toBe(sampleBody(FILENAME, 'skills'));
    expect(readFileSync(join(stagesDir, FILENAME), 'utf-8')).toBe(staleBody);
    rmSync(rootDir, { recursive: true, force: true });
  });
});
