import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { makeSeedMigration } from './_seedStageHelpers.js';

const STAGE_KEY = 'pipeline-test-seed-stage';
const FILENAME = 'pipeline-test-seed-stage.md';
const BODY = '# Test seed stage\n\nshipped body\n';

describe('makeSeedMigration', () => {
  let rootDir;
  let stagesDir;
  let refStagesDir;
  let installedConfigPath;

  const seedReference = ({ withConfig = true } = {}) => {
    writeFileSync(join(refStagesDir, FILENAME), BODY);
    if (withConfig) {
      writeFileSync(
        join(rootDir, 'data.reference', 'prompts', 'stage-config.json'),
        JSON.stringify({ stages: { [STAGE_KEY]: { name: STAGE_KEY, model: 'default', returnsJson: true, variables: [] } } }, null, 2) + '\n',
      );
    }
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'seed-stage-helper-'));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    refStagesDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    installedConfigPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(refStagesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns an object exposing only an async up() (no down — runner has no rollback)', () => {
    const migration = makeSeedMigration(STAGE_KEY);
    expect(typeof migration.up).toBe('function');
    expect(migration.down).toBeUndefined();
  });

  it('seeds the .md template and merges the stage-config entry on a fresh install', async () => {
    seedReference();
    const migration = makeSeedMigration(STAGE_KEY);
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

    await makeSeedMigration(STAGE_KEY).up({ rootDir });

    expect(readFileSync(join(stagesDir, FILENAME), 'utf8')).toBe(customBody);
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages[STAGE_KEY]).toEqual({ name: 'user-tuned', model: 'custom' });
  });

  it('merges into an existing config without disturbing other stages', async () => {
    seedReference();
    writeFileSync(
      installedConfigPath,
      JSON.stringify({ stages: { 'pipeline-other': { name: 'other' } } }, null, 2) + '\n',
    );

    await makeSeedMigration(STAGE_KEY).up({ rootDir });

    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages['pipeline-other']).toEqual({ name: 'other' });
    expect(installed.stages[STAGE_KEY]).toMatchObject({ returnsJson: true });
  });

  it('does not throw and seeds nothing when the data.reference samples are missing', async () => {
    await expect(makeSeedMigration(STAGE_KEY).up({ rootDir })).resolves.not.toThrow();
    expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    expect(existsSync(installedConfigPath)).toBe(false);
  });

  it('copies the .md but skips config when only the stage-config sample is missing', async () => {
    seedReference({ withConfig: false });
    await makeSeedMigration(STAGE_KEY).up({ rootDir });
    expect(readFileSync(join(stagesDir, FILENAME), 'utf8')).toBe(BODY);
    expect(existsSync(installedConfigPath)).toBe(false);
  });

  it('defaults filename to `${stageKey}.md` and logs under the stageKey', async () => {
    seedReference();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // No filename passed — must derive `${STAGE_KEY}.md` (which is FILENAME here).
    await makeSeedMigration(STAGE_KEY).up({ rootDir });
    expect(readFileSync(join(stagesDir, FILENAME), 'utf8')).toBe(BODY);
    expect(logSpy.mock.calls.some(([msg]) => String(msg).includes(`${STAGE_KEY} stage-config`))).toBe(true);
  });

  it('honors an explicit filename override that diverges from the stageKey', async () => {
    const altFile = 'pipeline-test-seed-stage-alt.md';
    writeFileSync(join(refStagesDir, altFile), BODY);
    writeFileSync(
      join(rootDir, 'data.reference', 'prompts', 'stage-config.json'),
      JSON.stringify({ stages: { [STAGE_KEY]: { name: STAGE_KEY, returnsJson: true } } }, null, 2) + '\n',
    );
    await makeSeedMigration(STAGE_KEY, { filename: altFile }).up({ rootDir });
    expect(readFileSync(join(stagesDir, altFile), 'utf8')).toBe(BODY);
    expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
  });
});
