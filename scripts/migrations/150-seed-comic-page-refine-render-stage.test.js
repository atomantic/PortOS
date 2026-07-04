import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import migration from './150-seed-comic-page-refine-render-stage.js';

// scripts/migrations/<this> → ../.. is the repo root (matches _testHelpers.js).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// First-shipment seed migration (mirrors 091) — no MD5 bookkeeping, so the
// seed/no-clobber behavior is asserted directly here.
const FILENAME = 'pipeline-comic-page-refine-render.md';
const STAGE_KEY = 'pipeline-comic-page-refine-render';
const SHIPPED_BODY = '# Comic page refine render\n\nshipped body\n';

describe('migration 100 — seed comic-page refine-render stage', () => {
  let rootDir;
  let stagesDir;
  let refStagesDir;
  let installedConfigPath;

  const seedReference = ({ withConfig = true } = {}) => {
    writeFileSync(join(refStagesDir, FILENAME), SHIPPED_BODY);
    if (withConfig) {
      const refConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
      writeFileSync(
        refConfigPath,
        JSON.stringify({
          stages: {
            [STAGE_KEY]: { name: STAGE_KEY, description: `${STAGE_KEY} desc`, model: 'default', returnsJson: true, variables: [] },
          },
        }, null, 2) + '\n',
      );
    }
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-100-'));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(refStagesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('seeds the .md template and merges the stage-config entry on a fresh install', async () => {
    seedReference();

    await expect(migration.up({ rootDir })).resolves.not.toThrow();

    expect(readFileSync(join(stagesDir, FILENAME), 'utf8')).toBe(SHIPPED_BODY);
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages[STAGE_KEY]).toMatchObject({ name: STAGE_KEY, returnsJson: true });
  });

  it('is idempotent and never clobbers a customized .md or an existing stage-config entry', async () => {
    seedReference();
    const customBody = '# CUSTOMIZED — do not overwrite\n';
    writeFileSync(join(stagesDir, FILENAME), customBody);
    writeFileSync(
      installedConfigPath,
      JSON.stringify({ stages: { [STAGE_KEY]: { name: 'user-tuned', model: 'custom' } } }, null, 2) + '\n',
    );

    await migration.up({ rootDir });

    // .md untouched; config entry preserved verbatim.
    expect(readFileSync(join(stagesDir, FILENAME), 'utf8')).toBe(customBody);
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages[STAGE_KEY]).toEqual({ name: 'user-tuned', model: 'custom' });
  });

  it('merges the stage-config entry alongside pre-existing unrelated stages', async () => {
    seedReference();
    writeFileSync(
      installedConfigPath,
      JSON.stringify({ stages: { 'some-other-stage': { name: 'other' } } }, null, 2) + '\n',
    );

    await migration.up({ rootDir });

    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages['some-other-stage']).toEqual({ name: 'other' });
    expect(installed.stages[STAGE_KEY]).toMatchObject({ name: STAGE_KEY });
  });

  it('does not throw when the data.reference sample is missing', async () => {
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
  });

  it('matches the live shipped stage-config key (drift catch)', () => {
    const refConfig = JSON.parse(
      readFileSync(join(repoRoot, 'data.reference', 'prompts', 'stage-config.json'), 'utf8'),
    );
    expect(refConfig.stages[STAGE_KEY], `stage-config missing ${STAGE_KEY}`).toBeTruthy();
    expect(existsSync(join(repoRoot, 'data.reference', 'prompts', 'stages', FILENAME))).toBe(true);
  });
});
