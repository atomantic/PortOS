import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration from './296-video-timeline-segments.js';

const CLIP_A = '11111111-1111-4111-8111-111111111111';
const CLIP_B = '22222222-2222-4222-8222-222222222222';

const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

describe('migration 296 — layered video timeline', () => {
  let rootDir;
  let projectsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-296-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    projectsPath = join(rootDir, 'data/video-projects.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  it('is a no-op on an install that has never used the timeline editor', async () => {
    const result = await migration.up({ rootDir });
    expect(result).toEqual({ ok: true, reason: 'no-projects-file', updated: 0 });
  });

  it('upgrades a v1 project to lanes while keeping the clips mirror', async () => {
    writeJson(projectsPath, [{
      id: 'p1',
      name: 'Example Project',
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-02T00:00:00.000Z',
      clips: [{ clipId: CLIP_A, inSec: 0, outSec: 4 }, { clipId: CLIP_B, inSec: 1, outSec: 2.5 }],
    }]);

    const result = await migration.up({ rootDir });
    const [project] = readJson(projectsPath);

    expect(result).toMatchObject({ ok: true, reason: 'updated', updated: 1 });
    expect(project.schemaVersion).toBe(2);
    expect(project.segments).toEqual([
      { type: 'clip', clipId: CLIP_A, inSec: 0, outSec: 4, fadeInSec: 0, fadeOutSec: 0, volume: 1 },
      { type: 'clip', clipId: CLIP_B, inSec: 1, outSec: 2.5, fadeInSec: 0, fadeOutSec: 0, volume: 1 },
    ]);
    expect(project.overlays).toEqual([]);
    expect(project.audio).toEqual({ clipVolume: 1, tracks: [] });
    // Retained so a rolled-back v1 build still renders the video lane.
    expect(project.clips).toEqual([{ clipId: CLIP_A, inSec: 0, outSec: 4 }, { clipId: CLIP_B, inSec: 1, outSec: 2.5 }]);
    // Untouched metadata survives.
    expect(project.name).toBe('Example Project');
    expect(project.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(project.updatedAt).toBe('2020-01-02T00:00:00.000Z');
  });

  it('drops a v1 clip with an inverted trim rather than carrying it into the lane', async () => {
    writeJson(projectsPath, [{ id: 'p1', clips: [{ clipId: CLIP_A, inSec: 5, outSec: 2 }, { clipId: CLIP_B, inSec: 0, outSec: 1 }] }]);

    await migration.up({ rootDir });
    const [project] = readJson(projectsPath);

    expect(project.segments).toHaveLength(1);
    expect(project.segments[0].clipId).toBe(CLIP_B);
    expect(project.clips).toEqual([{ clipId: CLIP_B, inSec: 0, outSec: 1 }]);
  });

  it('is idempotent — a second run reports already-current and rewrites nothing', async () => {
    writeJson(projectsPath, [{ id: 'p1', clips: [{ clipId: CLIP_A, inSec: 0, outSec: 2 }] }]);

    await migration.up({ rootDir });
    const afterFirst = readFileSync(projectsPath, 'utf8');
    const second = await migration.up({ rootDir });

    expect(second).toEqual({ ok: true, reason: 'already-current', updated: 0 });
    expect(readFileSync(projectsPath, 'utf8')).toBe(afterFirst);
  });

  it('upgrades only the projects that need it, in one pass', async () => {
    writeJson(projectsPath, [
      { id: 'v2', schemaVersion: 2, segments: [{ type: 'still', assetKind: 'images', assetFile: 'a.png', durationSec: 2 }], overlays: [], audio: { clipVolume: 1, tracks: [] }, clips: [] },
      { id: 'v1', clips: [{ clipId: CLIP_A, inSec: 0, outSec: 3 }] },
    ]);

    const result = await migration.up({ rootDir });
    const [alreadyV2, upgraded] = readJson(projectsPath);

    expect(result.updated).toBe(1);
    expect(alreadyV2.segments[0]).toMatchObject({ type: 'still', assetFile: 'a.png' });
    expect(upgraded.schemaVersion).toBe(2);
  });

  it('reports corrupt state instead of crashing the migration runner', async () => {
    writeFileSync(projectsPath, '{ not json');
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'invalid-json' });

    writeJson(projectsPath, { projects: [] });
    expect(await migration.up({ rootDir })).toMatchObject({ ok: false, reason: 'not-an-array' });
  });
});
