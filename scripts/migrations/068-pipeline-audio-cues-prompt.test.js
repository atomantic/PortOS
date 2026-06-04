import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './068-pipeline-audio-cues-prompt.js';

const STAGE = 'pipeline-audio-cues';
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 068 — seed whole-episode audio cue-planner prompt', () => {
  let rootDir;
  let installedStagesDir;
  let installedConfigPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-068-'));
    const refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    mkdirSync(refStagesDir, { recursive: true });
    writeFileSync(join(refStagesDir, `${STAGE}.md`), `# ${STAGE}\n\nbody\n`);
    const refConfig = { stages: { [STAGE]: { name: STAGE, model: 'default', returnsJson: true, variables: [] } } };
    writeFileSync(join(rootDir, 'data.reference', 'prompts', 'stage-config.json'), JSON.stringify(refConfig, null, 2) + '\n');

    installedStagesDir = join(rootDir, 'data', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('seeds the prompt file + stage-config entry on a fresh install', async () => {
    await migration.up({ rootDir });
    expect(existsSync(join(installedStagesDir, `${STAGE}.md`))).toBe(true);
    expect(readJson(installedConfigPath).stages[STAGE]).toBeTruthy();
  });

  it('merges into an existing stage-config without clobbering other stages', async () => {
    mkdirSync(installedStagesDir, { recursive: true });
    writeFileSync(installedConfigPath, JSON.stringify({ stages: { 'pipeline-prose': { name: 'Prose' } } }, null, 2) + '\n');
    await migration.up({ rootDir });
    const config = readJson(installedConfigPath);
    expect(config.stages['pipeline-prose']).toBeTruthy();
    expect(config.stages[STAGE]).toBeTruthy();
  });

  it('is idempotent and preserves a user-customized installed prompt', async () => {
    mkdirSync(installedStagesDir, { recursive: true });
    const customPath = join(installedStagesDir, `${STAGE}.md`);
    writeFileSync(customPath, '# CUSTOM cue planner\n');
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    // Second run is a clean no-op.
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    expect(readJson(installedConfigPath).stages[STAGE]).toBeTruthy();
  });
});
