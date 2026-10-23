import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './438-fableloom-stage-timeouts.js';

describe('migration 438 — FableLoom stage timeouts', () => {
  let rootDir;
  let configPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-438-'));
    mkdirSync(join(rootDir, 'data', 'prompts'), { recursive: true });
    configPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('sets the work-duration timeout on both stages, leaving other stages and fields alone, idempotently', async () => {
    writeFileSync(configPath, JSON.stringify({
      stages: {
        'fableloom-plan-shots': { name: 'Plan', model: 'default', returnsJson: true, variables: ['source'] },
        'fableloom-weave-episode': { name: 'Weave', model: 'heavy', returnsJson: true, variables: [] },
        'fableloom-review-shots': { name: 'Review', model: 'default', returnsJson: true },
      },
    }));

    expect(await migration.up({ rootDir })).toEqual({ stages: 2 });
    const { stages } = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(stages['fableloom-plan-shots']).toEqual({
      name: 'Plan', model: 'default', returnsJson: true, variables: ['source'], timeout: 1_200_000,
    });
    expect(stages['fableloom-weave-episode'].timeout).toBe(1_200_000);
    expect(stages['fableloom-review-shots']).toEqual({ name: 'Review', model: 'default', returnsJson: true });

    const afterFirst = readFileSync(configPath, 'utf8');
    expect(await migration.up({ rootDir })).toEqual({ stages: 0 });
    expect(readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });

  it('never overwrites a user-set timeout or a deleted stage', async () => {
    writeFileSync(configPath, JSON.stringify({
      stages: {
        'fableloom-plan-shots': { name: 'Plan', timeout: 60000 },
      },
    }));

    expect(await migration.up({ rootDir })).toEqual({ stages: 0 });
    const { stages } = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(stages['fableloom-plan-shots'].timeout).toBe(60000);
  });

  it('is a no-op when the stage config does not exist yet', async () => {
    expect(await migration.up({ rootDir })).toEqual({ stages: 0 });
  });

  it('refuses to guess at a corrupt stage config', async () => {
    writeFileSync(configPath, '{ not json');
    await expect(migration.up({ rootDir })).rejects.toThrow(/not valid JSON/);
  });
});
