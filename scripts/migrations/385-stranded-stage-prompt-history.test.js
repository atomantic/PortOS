import { execFileSync } from 'child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import migration, {
  applyMigration,
  ACCEPTED_OLD_MD5,
  NEW_SHIPPED_MD5,
} from './385-stranded-stage-prompt-history.js';
import { repoRoot, runPromptMigrationTests } from './_testHelpers.js';
import { isShallowRepository } from './shippedPromptHistory.js';

const strandedBodyCommit = '95ecbc86c5';
const promptPath =
  'data.reference/prompts/stages/fableloom-review-series-plan.md';

describe('migration 385 — previously stranded shipped stage-prompt history', () => {
  runPromptMigrationTests({
    migration,
    applyMigration,
    ACCEPTED_OLD_MD5,
    NEW_SHIPPED_MD5,
    prefix: 'migration-385-stranded-stage-prompt-history-',
  });

  const historyAvailable = !isShallowRepository(repoRoot);
  if (!historyAvailable) {
    console.warn(
      '⏭️ Skipping the original FableLoom prompt-body fixture: checkout has shallow git history',
    );
  }

  it.skipIf(!historyAvailable)(
    'upgrades the first shipped FableLoom plan-review body',
    async () => {
      const oldBody = execFileSync(
        'git',
        ['show', `${strandedBodyCommit}:${promptPath}`],
        {
          cwd: repoRoot,
          encoding: 'utf8',
        },
      );
      const rootDir = mkdtempSync(
        join(tmpdir(), 'migration-385-original-body-'),
      );
      try {
        const dataPath = join(
          rootDir,
          'data',
          'prompts',
          'stages',
          'fableloom-review-series-plan.md',
        );
        const samplePath = join(rootDir, promptPath);
        mkdirSync(join(rootDir, 'data', 'prompts', 'stages'), {
          recursive: true,
        });
        mkdirSync(join(rootDir, 'data.reference', 'prompts', 'stages'), {
          recursive: true,
        });
        writeFileSync(dataPath, oldBody);
        writeFileSync(
          samplePath,
          readFileSync(join(repoRoot, promptPath), 'utf8'),
        );

        await expect(applyMigration({ rootDir })).resolves.toMatchObject({
          updated: 1,
          skipped: 0,
        });
        expect(readFileSync(dataPath, 'utf8')).toBe(
          readFileSync(samplePath, 'utf8'),
        );
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    },
  );
});
