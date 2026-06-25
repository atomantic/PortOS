import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './125-beat-continuity-prompts.js';

const STAGES = ['pipeline-beat-continuity', 'pipeline-beat-continuity-resolve'];
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 125 — seed whole-manuscript beat-continuity prompts (#1510)', () => {
  let rootDir;
  let installedStagesDir;
  let installedConfigPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-125-'));
    const refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    mkdirSync(refStagesDir, { recursive: true });
    const refStages = {};
    for (const stage of STAGES) {
      writeFileSync(join(refStagesDir, `${stage}.md`), `# ${stage}\n\nbody\n`);
      refStages[stage] = { name: stage, model: 'heavy', returnsJson: true, variables: [] };
    }
    writeFileSync(
      join(rootDir, 'data.reference', 'prompts', 'stage-config.json'),
      JSON.stringify({ stages: refStages }, null, 2) + '\n',
    );

    installedStagesDir = join(rootDir, 'data', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('seeds both prompt files + stage-config entries on a fresh install', async () => {
    await migration.up({ rootDir });
    const config = readJson(installedConfigPath);
    for (const stage of STAGES) {
      expect(existsSync(join(installedStagesDir, `${stage}.md`))).toBe(true);
      expect(config.stages[stage]).toBeTruthy();
    }
  });

  it('merges into an existing stage-config without clobbering other stages', async () => {
    mkdirSync(installedStagesDir, { recursive: true });
    writeFileSync(installedConfigPath, JSON.stringify({ stages: { 'pipeline-prose': { name: 'Prose' } } }, null, 2) + '\n');
    await migration.up({ rootDir });
    const config = readJson(installedConfigPath);
    expect(config.stages['pipeline-prose']).toBeTruthy();
    for (const stage of STAGES) expect(config.stages[stage]).toBeTruthy();
  });

  it('is idempotent and preserves a user-customized installed prompt', async () => {
    mkdirSync(installedStagesDir, { recursive: true });
    const customPath = join(installedStagesDir, 'pipeline-beat-continuity.md');
    writeFileSync(customPath, '# CUSTOM beat continuity\n');
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    // The other (non-customized) stage is still seeded.
    expect(existsSync(join(installedStagesDir, 'pipeline-beat-continuity-resolve.md'))).toBe(true);
    // Second run is a clean no-op.
    await migration.up({ rootDir });
    expect(readFileSync(customPath, 'utf-8')).toContain('CUSTOM');
    for (const stage of STAGES) expect(readJson(installedConfigPath).stages[stage]).toBeTruthy();
  });
});
