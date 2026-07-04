import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import migration from './151-editorial-head-hopping-stage.js';

// scripts/migrations/<this> → ../.. is the repo root (matches _testHelpers.js).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// First-shipment seed migration (mirrors 110) — no MD5 bookkeeping, so the
// seed / no-clobber behavior is asserted directly.

const FILENAME = 'pipeline-editorial-head-hopping.md';
const STAGE_KEY = 'pipeline-editorial-head-hopping';
const BODY = '# Head-hopping / POV discipline\n\nshipped body\n';

describe('migration 112 — seed editorial-head-hopping stage', () => {
  let rootDir;
  let stagesDir;
  let refStagesDir;
  let installedConfigPath;

  const seedReference = ({ withConfig = true } = {}) => {
    writeFileSync(join(refStagesDir, FILENAME), BODY);
    if (withConfig) {
      const refConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
      writeFileSync(
        refConfigPath,
        JSON.stringify({ stages: { [STAGE_KEY]: { name: STAGE_KEY, description: 'desc', model: 'default', returnsJson: true, variables: [] } } }, null, 2) + '\n',
      );
    }
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-112-'));
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
    expect(readFileSync(join(stagesDir, FILENAME), 'utf8')).toBe(BODY);
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages[STAGE_KEY]).toMatchObject({ returnsJson: true });
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

    expect(readFileSync(join(stagesDir, FILENAME), 'utf8')).toBe(customBody);
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages[STAGE_KEY]).toEqual({ name: 'user-tuned', model: 'custom' });
  });

  it('does not throw when the data.reference samples are missing', async () => {
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
  });

  it('matches the live shipped stage-config key + prompt file (drift catch)', () => {
    const refConfig = JSON.parse(
      readFileSync(join(repoRoot, 'data.reference', 'prompts', 'stage-config.json'), 'utf8'),
    );
    expect(refConfig.stages[STAGE_KEY], `stage-config missing ${STAGE_KEY}`).toBeTruthy();
    expect(refConfig.stages[STAGE_KEY].returnsJson).toBe(true);
    expect(existsSync(join(repoRoot, 'data.reference', 'prompts', 'stages', FILENAME))).toBe(true);
  });
});
