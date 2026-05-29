import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './043-story-builder-prompts.js';

const STAGES = ['story-builder-idea-expand', 'story-builder-reader-map', 'story-builder-reader-map-refine'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 043 — seed Story Builder prompts', () => {
  let rootDir;
  let installedStagesDir;
  let installedConfigPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-043-'));
    // Seed the data.reference fixtures the migration copies FROM.
    const refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    mkdirSync(refStagesDir, { recursive: true });
    for (const key of STAGES) {
      writeFileSync(join(refStagesDir, `${key}.md`), `# ${key}\n\nbody for ${key}\n`);
    }
    const refConfig = { stages: {} };
    for (const key of STAGES) {
      refConfig.stages[key] = { name: key, model: 'default', returnsJson: true, variables: [] };
    }
    writeFileSync(join(rootDir, 'data.reference', 'prompts', 'stage-config.json'), JSON.stringify(refConfig, null, 2) + '\n');

    installedStagesDir = join(rootDir, 'data', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('seeds all three prompt files + stage-config entries on a fresh install', async () => {
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
    // User already customized one of the prompts — the migration must not overwrite it.
    const customPath = join(installedStagesDir, 'story-builder-reader-map.md');
    writeFileSync(customPath, '# CUSTOM reader map\n');
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    // Second run is a clean no-op.
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    const config = readJson(installedConfigPath);
    expect(Object.keys(config.stages).filter((k) => STAGES.includes(k))).toHaveLength(3);
  });
});
