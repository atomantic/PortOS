import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './048-catalog-ideas-scenes-concepts-stage.js';

const STAGES = ['catalog-ideas-scenes-concepts'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 048 — seed catalog ingest light-shape stage', () => {
  let rootDir;
  let installedStagesDir;
  let installedConfigPath;
  let refStagesDir;
  let refConfigPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-048-'));
    refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    refConfigPath = join(rootDir, 'data.reference', 'prompts', 'stage-config.json');
    mkdirSync(refStagesDir, { recursive: true });
    for (const key of STAGES) {
      writeFileSync(join(refStagesDir, `${key}.md`), `# ${key}\n\nbody for ${key}\n`);
    }
    const refConfig = { stages: {} };
    for (const key of STAGES) {
      refConfig.stages[key] = { name: key, model: 'default', returnsJson: true, variables: [] };
    }
    writeFileSync(refConfigPath, JSON.stringify(refConfig, null, 2) + '\n');

    installedStagesDir = join(rootDir, 'data', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('seeds the prompt file + stage-config entry on a fresh install', async () => {
    await migration.up({ rootDir });
    for (const key of STAGES) {
      expect(existsSync(join(installedStagesDir, `${key}.md`))).toBe(true);
    }
    const config = readJson(installedConfigPath);
    for (const key of STAGES) {
      expect(config.stages[key]).toBeTruthy();
    }
  });

  it('merges into an existing stage-config without clobbering other stages', async () => {
    mkdirSync(installedStagesDir, { recursive: true });
    writeFileSync(installedConfigPath, JSON.stringify({ stages: { 'pipeline-prose': { name: 'Prose' } } }, null, 2) + '\n');
    await migration.up({ rootDir });
    const config = readJson(installedConfigPath);
    expect(config.stages['pipeline-prose']).toBeTruthy();
    for (const key of STAGES) {
      expect(config.stages[key]).toBeTruthy();
    }
  });

  it('is idempotent and preserves a user-customized installed prompt', async () => {
    mkdirSync(installedStagesDir, { recursive: true });
    const customPath = join(installedStagesDir, 'catalog-ideas-scenes-concepts.md');
    writeFileSync(customPath, '# CUSTOM ideas/scenes/concepts\n');
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    // Second run is a clean no-op.
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    const config = readJson(installedConfigPath);
    expect(Object.keys(config.stages).filter((k) => STAGES.includes(k))).toHaveLength(1);
  });

  it('logs and skips when the data.reference template is missing (no crash)', async () => {
    rmSync(join(refStagesDir, 'catalog-ideas-scenes-concepts.md'));
    await migration.up({ rootDir });
    // Stage-config merge still runs from refConfigPath, so the entry lands
    // even without the .md (the runtime stageRunner will then throw at first
    // use — but the migration itself stays non-fatal so boot succeeds).
    expect(existsSync(join(installedStagesDir, 'catalog-ideas-scenes-concepts.md'))).toBe(false);
  });

  it('logs and skips when the data.reference stage-config is missing (no crash)', async () => {
    rmSync(refConfigPath);
    await migration.up({ rootDir });
    // .md still copies even when the config side is unavailable.
    expect(existsSync(join(installedStagesDir, 'catalog-ideas-scenes-concepts.md'))).toBe(true);
  });
});
