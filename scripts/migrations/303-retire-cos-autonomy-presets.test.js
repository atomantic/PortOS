import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import migration, { RETIRED_COS_CONFIG_KEYS } from './303-retire-cos-autonomy-presets.js';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 303 — retire CoS autonomy presets', () => {
  let rootDir;
  let statePath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-303-cos-config-'));
    mkdirSync(join(rootDir, 'data', 'cos'), { recursive: true });
    statePath = join(rootDir, 'data', 'cos', 'state.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('removes only retired global fields and preserves runtime and per-job data', async () => {
    writeFileSync(statePath, JSON.stringify({
      config: {
        maxConcurrentAgents: 4,
        domainAutonomy: { cos: 'dry-run' },
        autonomyLevel: 'manager',
        comprehensiveAppImprovement: true,
        immediateExecution: true,
      },
      persistentMind: { status: 'waiting' },
      jobs: [{ id: 'job-1', autonomyLevel: 'manager' }],
    }));

    await expect(migration.up({ rootDir })).resolves.toEqual({
      updated: 1,
      removed: RETIRED_COS_CONFIG_KEYS,
    });
    expect(readJson(statePath)).toEqual({
      config: { maxConcurrentAgents: 4, domainAutonomy: { cos: 'dry-run' } },
      persistentMind: { status: 'waiting' },
      jobs: [{ id: 'job-1', autonomyLevel: 'manager' }],
    });
  });

  it('is idempotent and leaves malformed state untouched', async () => {
    writeFileSync(statePath, JSON.stringify({ config: { maxConcurrentAgents: 3 } }));
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'already-applied' });

    writeFileSync(statePath, '{broken');
    await expect(migration.up({ rootDir })).resolves.toEqual({ updated: 0, reason: 'invalid-state' });
    expect(readFileSync(statePath, 'utf8')).toBe('{broken');
  });
});
