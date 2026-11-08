import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import migration, { migrateMusicVideoPreviz } from './459-music-video-previz-timeline.js';
import { musicVideoPrevizSchema } from '../../server/lib/musicVideoValidation.js';

const legacy = (extra = {}) => ({
  id: 'p1',
  concept: { subjects: [{ id: 'c-a', kind: 'character', name: 'Ana' }] },
  previz: {
    cuts: [], pawnColors: { 'c-a': { figure: 'red', bike: 'chrome' } },
    tracks: [{ subjectId: 'c-a', placeSubjectId: 'p', keys: [{ timeSec: 0, position: [0, 0, 0], facingDegrees: 0, pose: 'ride' }, { timeSec: 1, position: [0, 0, 1], facingDegrees: 0, pose: 'stand' }] }],
    night: { startClock: 1200, lengthMin: 60, beats: [
      { id: 'a', kind: 'stay', subjectIds: ['c-a'], startMin: 0, endMin: 10, setId: 's1', toSetId: null, pace: null },
      { id: 'b', kind: 'travel', subjectIds: ['c-a'], startMin: 10, endMin: 20, setId: 's1', toSetId: 's2', pace: 'ride' },
    ] },
    ...extra,
  },
});

describe('migration 459 — previz timeline and vehicles', () => {
  // Catches a project losing its story clock or its riders' pose when the stored shape moves.
  it('renames night to timeline and turns the bike into a vehicle object that keeps its color', () => {
    const next = migrateMusicVideoPreviz(legacy());
    expect(next.previz.night).toBeUndefined();
    expect(next.concept.subjects.at(-1)).toMatchObject({ kind: 'object', name: 'Bike', localOnly: true });
    const id = next.concept.subjects.at(-1).id;
    expect(next.previz.vehicles).toEqual([{ subjectId: id, speedMetersPerMin: 270 }]);
    expect(next.previz.pawnColors).toEqual({ 'c-a': { figure: 'red' }, [id]: { figure: 'chrome' } });
    expect(next.previz.timeline.beats[1]).toMatchObject({ pace: 'walk', vehicleSubjectId: id });
    expect(next.previz.timeline.beats[0].vehicleSubjectId).toBeUndefined();
    expect(next.previz.tracks[0].keys.map((key) => [key.pose, key.vehicleSubjectId])).toEqual([['ride', id], ['stand', undefined]]);
    expect(musicVideoPrevizSchema.safeParse(next.previz).success).toBe(true);
  });

  it('reuses a bike-like object already in the cast', () => {
    const record = legacy();
    record.concept.subjects.push({ id: 'o-1', kind: 'object', name: 'Red bicycle' });
    const next = migrateMusicVideoPreviz(record);
    expect(next.concept.subjects).toHaveLength(2);
    expect(next.previz.vehicles[0].subjectId).toBe('o-1');
  });

  it('adds no vehicle to a cast that never rode, and is idempotent', () => {
    const walking = legacy();
    walking.previz.night.beats[1].pace = 'walk';
    walking.previz.tracks[0].keys[0].pose = 'stand';
    const next = migrateMusicVideoPreviz(walking);
    expect(next.previz.vehicles).toBeUndefined();
    expect(next.concept.subjects).toHaveLength(1);
    expect(migrateMusicVideoPreviz(next)).toBe(next);
    expect(migrateMusicVideoPreviz({ id: 'x' })).toEqual({ id: 'x' });
  });

  describe('file run', () => {
    let rootDir;
    beforeEach(() => { rootDir = mkdtempSync(join(tmpdir(), 'migration-459-')); mkdirSync(join(rootDir, 'data')); });
    afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

    it('rewrites the project file and tolerates a missing one', async () => {
      expect(await migration.up({ rootDir })).toEqual({ success: true });
      writeFileSync(join(rootDir, 'data', 'music-video-projects.json'), JSON.stringify([legacy()]));
      await migration.up({ rootDir });
      const [saved] = JSON.parse(readFileSync(join(rootDir, 'data', 'music-video-projects.json'), 'utf8'));
      expect(saved.previz.timeline.beats).toHaveLength(2);
    });
  });
});
