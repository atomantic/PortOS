import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import migration from './165-reader-panel-persona-stages.js';

// scripts/migrations/<this> → ../.. is the repo root (matches _testHelpers.js).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// First-shipment seed migration (mirrors 095/133) — no MD5 bookkeeping, so the
// seed / no-clobber behavior is asserted directly.

const STAGE_KEYS = [
  'pipeline-panel-editor',
  'pipeline-panel-genre-reader',
  'pipeline-panel-writer',
  'pipeline-panel-first-reader',
];

describe('migration 165 — seed reader-panel persona stages', () => {
  let rootDir;
  let stagesDir;
  let refStagesDir;
  let installedConfigPath;

  const seedReference = () => {
    for (const key of STAGE_KEYS) writeFileSync(join(refStagesDir, `${key}.md`), `# ${key}\n\nshipped body\n`);
    const refConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    const stages = Object.fromEntries(STAGE_KEYS.map((key) => [key, { name: key, description: 'desc', model: 'heavy', returnsJson: true, variables: [] }]));
    writeFileSync(refConfigPath, JSON.stringify({ stages }, null, 2) + '\n');
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-165-'));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(refStagesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('seeds all four persona templates and merges their stage-config entries', async () => {
    seedReference();
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    for (const key of STAGE_KEYS) {
      expect(readFileSync(join(stagesDir, `${key}.md`), 'utf8')).toContain(key);
      expect(installed.stages[key]).toMatchObject({ returnsJson: true });
    }
  });

  it('is idempotent and never clobbers a customized .md or an existing stage-config entry', async () => {
    seedReference();
    const customBody = '# CUSTOMIZED — do not overwrite\n';
    writeFileSync(join(stagesDir, 'pipeline-panel-editor.md'), customBody);
    writeFileSync(
      installedConfigPath,
      JSON.stringify({ stages: { 'pipeline-panel-editor': { name: 'user-tuned', model: 'custom' } } }, null, 2) + '\n',
    );

    await migration.up({ rootDir });

    expect(readFileSync(join(stagesDir, 'pipeline-panel-editor.md'), 'utf8')).toBe(customBody);
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages['pipeline-panel-editor']).toEqual({ name: 'user-tuned', model: 'custom' });
    // the other three still seed
    expect(installed.stages['pipeline-panel-writer']).toMatchObject({ returnsJson: true });
  });

  it('does not throw when the data.reference samples are missing', async () => {
    await expect(migration.up({ rootDir })).resolves.not.toThrow();
    expect(existsSync(join(stagesDir, 'pipeline-panel-editor.md'))).toBe(false);
  });

  it('matches the live shipped stage-config keys + prompt files (drift catch)', () => {
    const refConfig = JSON.parse(
      readFileSync(join(repoRoot, 'data.reference', 'prompts', 'stage-config.json'), 'utf8'),
    );
    for (const key of STAGE_KEYS) {
      expect(refConfig.stages[key], `stage-config missing ${key}`).toBeTruthy();
      expect(refConfig.stages[key].returnsJson).toBe(true);
      expect(existsSync(join(repoRoot, 'data.reference', 'prompts', 'stages', `${key}.md`))).toBe(true);
    }
  });
});
