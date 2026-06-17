import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import migration from './095-pov-rewrite-stages.js';

// scripts/migrations/<this> → ../.. is the repo root (matches _testHelpers.js).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// First-shipment seed migration (mirrors 091's two-file seed test) — no MD5
// bookkeeping, so the seed/no-clobber behavior is asserted directly.

const FILES = [
  { filename: 'pipeline-pov-rewrite.md', stageKey: 'pipeline-pov-rewrite', body: '# POV rewrite\n\nshipped body\n', returnsJson: false },
  { filename: 'pipeline-pov-analysis.md', stageKey: 'pipeline-pov-analysis', body: '# POV analysis\n\nshipped body\n', returnsJson: true },
];

describe('migration 095 — seed POV rewrite stages', () => {
  let rootDir;
  let stagesDir;
  let refStagesDir;
  let installedConfigPath;

  const seedReference = ({ withConfig = true } = {}) => {
    for (const { filename, body } of FILES) {
      writeFileSync(join(refStagesDir, filename), body);
    }
    if (withConfig) {
      const refConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
      const stages = {};
      for (const { stageKey, returnsJson } of FILES) {
        stages[stageKey] = { name: stageKey, description: `${stageKey} desc`, model: 'heavy', returnsJson, variables: [] };
      }
      writeFileSync(refConfigPath, JSON.stringify({ stages }, null, 2) + '\n');
    }
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-095-'));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(refStagesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('seeds both .md templates and merges both stage-config entries on a fresh install', async () => {
    seedReference();

    await expect(migration.up({ rootDir })).resolves.not.toThrow();

    for (const { filename, body } of FILES) {
      expect(readFileSync(join(stagesDir, filename), 'utf8')).toBe(body);
    }
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages['pipeline-pov-rewrite']).toMatchObject({ returnsJson: false });
    expect(installed.stages['pipeline-pov-analysis']).toMatchObject({ returnsJson: true });
  });

  it('is idempotent and never clobbers a customized .md or an existing stage-config entry', async () => {
    seedReference();
    const customBody = '# CUSTOMIZED — do not overwrite\n';
    for (const { filename } of FILES) {
      writeFileSync(join(stagesDir, filename), customBody);
    }
    writeFileSync(
      installedConfigPath,
      JSON.stringify({ stages: { [FILES[0].stageKey]: { name: 'user-tuned', model: 'custom' } } }, null, 2) + '\n',
    );

    await migration.up({ rootDir });

    for (const { filename } of FILES) {
      expect(readFileSync(join(stagesDir, filename), 'utf8')).toBe(customBody);
    }
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages[FILES[0].stageKey]).toEqual({ name: 'user-tuned', model: 'custom' });
    expect(installed.stages[FILES[1].stageKey]).toMatchObject({ name: FILES[1].stageKey });
  });

  it('does not throw when the data.reference samples are missing', async () => {
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    for (const { filename } of FILES) {
      expect(existsSync(join(stagesDir, filename))).toBe(false);
    }
  });

  it('matches the live shipped stage-config keys + prompt files (drift catch)', () => {
    const refConfig = JSON.parse(
      readFileSync(join(repoRoot, 'data.reference', 'prompts', 'stage-config.json'), 'utf8'),
    );
    for (const { stageKey, filename, returnsJson } of FILES) {
      expect(refConfig.stages[stageKey], `stage-config missing ${stageKey}`).toBeTruthy();
      expect(refConfig.stages[stageKey].returnsJson).toBe(returnsJson);
      expect(existsSync(join(repoRoot, 'data.reference', 'prompts', 'stages', filename))).toBe(true);
    }
  });
});
