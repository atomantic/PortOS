import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './174-series-voice-discover-stage.js';

const STAGES = ['pipeline-series-voice-discover'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 174 — seed series voice-discovery stage', () => {
  let rootDir;
  let installedStagesDir;
  let installedConfigPath;
  let refStagesDir;
  let refConfigPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-174-'));
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
    const customPath = join(installedStagesDir, 'pipeline-series-voice-discover.md');
    writeFileSync(customPath, '# CUSTOM voice discovery\n');
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    // Second run is a clean no-op.
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    const config = readJson(installedConfigPath);
    expect(Object.keys(config.stages).filter((k) => STAGES.includes(k))).toHaveLength(1);
  });

  it('logs and skips when the data.reference template is missing (no crash)', async () => {
    rmSync(join(refStagesDir, 'pipeline-series-voice-discover.md'));
    await migration.up({ rootDir });
    expect(existsSync(join(installedStagesDir, 'pipeline-series-voice-discover.md'))).toBe(false);
  });

  it('logs and skips when the data.reference stage-config is missing (no crash)', async () => {
    rmSync(refConfigPath);
    await migration.up({ rootDir });
    expect(existsSync(join(installedStagesDir, 'pipeline-series-voice-discover.md'))).toBe(true);
  });
});
