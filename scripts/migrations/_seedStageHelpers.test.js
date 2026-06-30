import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { makeSeedMigration, makeSeedMigrations } from './_seedStageHelpers.js';

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

  it('defaults filename to `${stageKey}.md` and logs an `N added` config summary', async () => {
    seedReference();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // No filename passed — must derive `${STAGE_KEY}.md` (which is FILENAME here).
    await makeSeedMigration(STAGE_KEY).up({ rootDir });
    expect(readFileSync(join(stagesDir, FILENAME), 'utf8')).toBe(BODY);
    expect(logSpy.mock.calls.some(([msg]) => /stage-config \((merged|created)\): 1 added/.test(String(msg)))).toBe(true);
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

describe('makeSeedMigrations (multi-stage)', () => {
  let rootDir;
  let stagesDir;
  let refStagesDir;
  let installedConfigPath;

  const KEYS = ['pipeline-multi-a', 'pipeline-multi-b'];
  const bodyFor = (key) => `# ${key}\n\nshipped body\n`;

  const seedReference = ({ withConfig = true, keys = KEYS } = {}) => {
    for (const key of keys) writeFileSync(join(refStagesDir, `${key}.md`), bodyFor(key));
    if (withConfig) {
      const stages = {};
      for (const key of keys) stages[key] = { name: key, model: 'default', returnsJson: true, variables: [] };
      writeFileSync(
        join(rootDir, 'data.reference', 'prompts', 'stage-config.json'),
        JSON.stringify({ stages }, null, 2) + '\n',
      );
    }
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'seed-stages-helper-'));
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

  it('seeds every .md template and merges every config entry in one write on a fresh install', async () => {
    seedReference();
    await expect(makeSeedMigrations(KEYS).up({ rootDir })).resolves.not.toThrow();
    for (const key of KEYS) {
      expect(readFileSync(join(stagesDir, `${key}.md`), 'utf8')).toBe(bodyFor(key));
      expect(JSON.parse(readFileSync(installedConfigPath, 'utf8')).stages[key]).toMatchObject({ returnsJson: true });
    }
  });

  it('writes the installed config exactly once with an `N added` summary', async () => {
    seedReference();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await makeSeedMigrations(KEYS).up({ rootDir });
    expect(logSpy.mock.calls.some(([msg]) => /stage-config \(created\): 2 added/.test(String(msg)))).toBe(true);
  });

  it('only adds absent entries — existing entries are preserved verbatim', async () => {
    seedReference();
    writeFileSync(
      installedConfigPath,
      JSON.stringify({ stages: { [KEYS[0]]: { name: 'user-tuned', model: 'custom' } } }, null, 2) + '\n',
    );
    await makeSeedMigrations(KEYS).up({ rootDir });
    const installed = JSON.parse(readFileSync(installedConfigPath, 'utf8'));
    expect(installed.stages[KEYS[0]]).toEqual({ name: 'user-tuned', model: 'custom' });
    expect(installed.stages[KEYS[1]]).toMatchObject({ name: KEYS[1] });
  });

  it('never clobbers a customized .md that is already present', async () => {
    seedReference();
    const customBody = '# CUSTOMIZED — do not overwrite\n';
    writeFileSync(join(stagesDir, `${KEYS[0]}.md`), customBody);
    await makeSeedMigrations(KEYS).up({ rootDir });
    expect(readFileSync(join(stagesDir, `${KEYS[0]}.md`), 'utf8')).toBe(customBody);
    expect(readFileSync(join(stagesDir, `${KEYS[1]}.md`), 'utf8')).toBe(bodyFor(KEYS[1]));
  });

  it('does not write the config when every entry is already present', async () => {
    seedReference();
    const stages = {};
    for (const key of KEYS) stages[key] = { name: 'preexisting' };
    const original = JSON.stringify({ stages }, null, 2) + '\n';
    writeFileSync(installedConfigPath, original);
    await makeSeedMigrations(KEYS).up({ rootDir });
    expect(readFileSync(installedConfigPath, 'utf8')).toBe(original);
  });

  it('does not throw and seeds nothing when the data.reference samples are missing', async () => {
    await expect(makeSeedMigrations(KEYS).up({ rootDir })).resolves.not.toThrow();
    for (const key of KEYS) expect(existsSync(join(stagesDir, `${key}.md`))).toBe(false);
    expect(existsSync(installedConfigPath)).toBe(false);
  });

  it('accepts `{ stageKey, filename }` specs with a diverging basename', async () => {
    const altFile = 'pipeline-multi-a-alt.md';
    writeFileSync(join(refStagesDir, altFile), bodyFor(KEYS[0]));
    writeFileSync(
      join(rootDir, 'data.reference', 'prompts', 'stage-config.json'),
      JSON.stringify({ stages: { [KEYS[0]]: { name: KEYS[0], returnsJson: true } } }, null, 2) + '\n',
    );
    await makeSeedMigrations([{ stageKey: KEYS[0], filename: altFile }]).up({ rootDir });
    expect(readFileSync(join(stagesDir, altFile), 'utf8')).toBe(bodyFor(KEYS[0]));
    expect(existsSync(join(stagesDir, `${KEYS[0]}.md`))).toBe(false);
  });
});
