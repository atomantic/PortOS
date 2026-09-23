import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './409-canonical-stage-model-tiers.js';

describe('migration 409 — canonical stage model tiers', () => {
  let rootDir;
  let configPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-409-'));
    mkdirSync(join(rootDir, 'data', 'prompts'), { recursive: true });
    configPath = join(rootDir, 'data', 'prompts', 'stage-config.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('rewrites quick/coding on model and judgeModel, leaving pins and other tiers alone, idempotently', async () => {
    writeFileSync(configPath, JSON.stringify({
      stages: {
        a: { name: 'A', model: 'quick', judgeModel: 'coding', variables: [] },
        b: { name: 'B', model: 'heavy' },
        c: { name: 'C', provider: 'lmstudio', model: 'coding-model-7b' },
        d: { name: 'D', model: 'default', judgeModel: 'quick' },
      },
    }));

    expect(await migration.up({ rootDir })).toEqual({ stages: 2 });
    const { stages } = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(stages.a).toEqual({ name: 'A', model: 'light', judgeModel: 'medium', variables: [] });
    expect(stages.b.model).toBe('heavy');
    expect(stages.c.model).toBe('coding-model-7b');
    expect(stages.d).toEqual({ name: 'D', model: 'default', judgeModel: 'light' });

    const afterFirst = readFileSync(configPath, 'utf8');
    expect(await migration.up({ rootDir })).toEqual({ stages: 0 });
    expect(readFileSync(configPath, 'utf8')).toBe(afterFirst);
  });

  it('is a no-op when the stage config does not exist yet', async () => {
    expect(await migration.up({ rootDir })).toEqual({ stages: 0 });
  });

  it('refuses to guess at a corrupt stage config', async () => {
    writeFileSync(configPath, '{ not json');
    await expect(migration.up({ rootDir })).rejects.toThrow(/not valid JSON/);
  });
});
