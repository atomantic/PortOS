import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './222-storyboard-scene-durable-ids.js';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf-8'));

describe('migration 222 — storyboard scene durable ids', () => {
  let rootDir;
  let typeDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-222-'));
    typeDir = join(rootDir, 'data', 'pipeline-issues');
    mkdirSync(typeDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  const writeIssue = (id, issue) => {
    const dir = join(typeDir, id);
    mkdirSync(dir, { recursive: true });
    writeJson(join(dir, 'index.json'), issue);
  };
  const readIssue = (id) => readJson(join(typeDir, id, 'index.json'));

  it('backfills scene + shot ids on an existing install', async () => {
    writeIssue('iss-a', {
      id: 'iss-a',
      updatedAt: '2026-01-01T00:00:00.000Z',
      stages: {
        storyboards: {
          scenes: [
            { description: 'one', shots: [{ description: 'wide' }] },
            { description: 'two' },
          ],
        },
      },
    });

    await migration.up({ rootDir });

    const a = readIssue('iss-a');
    expect(a.stages.storyboards.scenes.map((s) => s.id)).toEqual(['scene-01', 'scene-02']);
    expect(a.stages.storyboards.scenes[0].shots[0].id).toBe('shot-01');
    // Derived normalization — the LWW clock must not advance.
    expect(a.updatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is idempotent and leaves already-stamped records byte-identical', async () => {
    writeIssue('iss-b', {
      id: 'iss-b',
      stages: { storyboards: { scenes: [{ id: 'custom', description: 'kept' }] } },
    });
    const before = readFileSync(join(typeDir, 'iss-b', 'index.json'), 'utf-8');

    await migration.up({ rootDir });
    await migration.up({ rootDir });

    expect(readFileSync(join(typeDir, 'iss-b', 'index.json'), 'utf-8')).toBe(before);
  });

  it('skips issues with no storyboard scenes and tolerates unreadable records', async () => {
    writeIssue('iss-c', { id: 'iss-c', stages: { storyboards: { scenes: [] } } });
    writeIssue('iss-d', { id: 'iss-d', stages: {} });
    mkdirSync(join(typeDir, 'iss-e'), { recursive: true });
    writeFileSync(join(typeDir, 'iss-e', 'index.json'), '{ not json');

    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
    expect(readIssue('iss-c').stages.storyboards.scenes).toEqual([]);
  });

  it('no-ops on a fresh install with no pipeline-issues dir', async () => {
    rmSync(typeDir, { recursive: true, force: true });
    await expect(migration.up({ rootDir })).resolves.toBeUndefined();
  });
});
