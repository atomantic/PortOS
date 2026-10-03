/**
 * dataSync goals snapshot merge — document freshness for metadata (#9818).
 *
 * `setBirthDate` stamps the goals DOCUMENT's `updatedAt` and never restamps a
 * child goal, so a snapshot merge that ordered the metadata (birthDate /
 * lifeExpectancy / timeHorizons) by the newest child-goal timestamp ignored a
 * metadata-only edit — with no goals, or with unchanged goals, both sides
 * scored the same and the stale local value kept winning forever (the
 * orchestrator acks the snapshot checksum, so an unchanged source is never
 * retried). These cases drive the real goals store through `applyRemote` and
 * read the file back, so "no write on replay" is checked against disk.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { readFile, writeFile, mkdir, stat } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-datasync-goals-meta-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

const { PATHS } = await import('../lib/fileUtils.js');
const dataSync = await import('./dataSync.js');

afterAll(cleanup);

const GOALS_PATH = () => join(PATHS.digitalTwin, 'goals.json');

const goal = (id, updatedAt) => ({ id, title: `Goal ${id}`, status: 'active', updatedAt });

const seedLocal = async doc => {
  await mkdir(PATHS.digitalTwin, { recursive: true });
  await writeFile(GOALS_PATH(), JSON.stringify(doc));
};
const readLocal = async () => JSON.parse(await readFile(GOALS_PATH(), 'utf8'));

// Placeholder birth dates — fixtures never carry a real one.
const OLD_META = { birthDate: '1990-01-01', lifeExpectancy: { adjusted: 80 }, timeHorizons: { yearsRemaining: 40 } };
const NEW_META = { birthDate: '1991-01-01', lifeExpectancy: { adjusted: 81 }, timeHorizons: { yearsRemaining: 41 } };

beforeEach(async () => {
  await seedLocal({ ...OLD_META, goals: [], updatedAt: '2026-01-10T00:00:00.000Z' });
});

describe('dataSync goals — metadata LWW on the document clock', () => {
  it('applies a newer metadata-only snapshot when both goal arrays are empty, carries its clock, and a replay is a no-op', async () => {
    const remote = { ...NEW_META, goals: [], updatedAt: '2026-02-10T00:00:00.000Z' };

    const first = await dataSync.applyRemote('goals', remote);
    expect(first.applied).toBe(true);
    const merged = await readLocal();
    expect(merged).toMatchObject({ ...NEW_META, updatedAt: remote.updatedAt });

    const before = await stat(GOALS_PATH());
    const replay = await dataSync.applyRemote('goals', remote);
    expect(replay).toEqual({ applied: false, count: 0 });
    expect(await readLocal()).toEqual(merged);
    expect((await stat(GOALS_PATH())).mtimeMs).toBe(before.mtimeMs);
  });

  it('applies a newer metadata-only snapshot when the shared child goal clock is unchanged', async () => {
    const shared = goal('goal-1', '2026-01-05T00:00:00.000Z');
    await seedLocal({ ...OLD_META, goals: [shared], updatedAt: '2026-01-10T00:00:00.000Z' });

    const result = await dataSync.applyRemote('goals', {
      ...NEW_META, goals: [shared], updatedAt: '2026-02-10T00:00:00.000Z'
    });

    expect(result.applied).toBe(true);
    expect(await readLocal()).toMatchObject({ birthDate: NEW_META.birthDate, updatedAt: '2026-02-10T00:00:00.000Z' });
  });

  it('keeps newer local metadata when an older document carries a newer child goal', async () => {
    await seedLocal({ ...NEW_META, goals: [goal('goal-1', '2026-01-05T00:00:00.000Z')], updatedAt: '2026-03-01T00:00:00.000Z' });

    const result = await dataSync.applyRemote('goals', {
      ...OLD_META,
      goals: [goal('goal-2', '2026-04-01T00:00:00.000Z')],
      updatedAt: '2026-01-20T00:00:00.000Z'
    });

    // The goal union still applies; the stale document must not take the metadata or the clock.
    expect(result.applied).toBe(true);
    const merged = await readLocal();
    expect(merged.goals.map(g => g.id).sort()).toEqual(['goal-1', 'goal-2']);
    expect(merged).toMatchObject({ ...NEW_META, updatedAt: '2026-03-01T00:00:00.000Z' });
  });

  it('falls back to the newest child goal clock only when a document has no usable clock', async () => {
    await seedLocal({ ...OLD_META, goals: [goal('goal-1', '2026-01-05T00:00:00.000Z')] });

    // Legacy remote (no document clock) with a newer child goal wins the metadata.
    const legacyNewer = await dataSync.applyRemote('goals', {
      ...NEW_META, goals: [goal('goal-1', '2026-02-05T00:00:00.000Z')]
    });
    expect(legacyNewer.applied).toBe(true);
    expect(await readLocal()).toMatchObject({ birthDate: NEW_META.birthDate });

    // A legacy remote whose newest child is older does not.
    const staleLegacy = await dataSync.applyRemote('goals', {
      ...OLD_META, goals: [goal('goal-1', '2026-01-01T00:00:00.000Z')]
    });
    expect(staleLegacy).toEqual({ applied: false, count: 0 });
    expect(await readLocal()).toMatchObject({ birthDate: NEW_META.birthDate });
  });

  it('does not let a goal the receiver already deleted stand in as proof of a fresher legacy document', async () => {
    await seedLocal({
      ...OLD_META,
      goals: [goal('goal-1', '2026-01-05T00:00:00.000Z')],
      goalTombstones: [{ id: 'goal-2', deletedAt: '2026-02-01T00:00:00.000Z' }]
    });

    // The only thing making this clockless remote look newer is a copy of the deleted goal.
    const result = await dataSync.applyRemote('goals', {
      ...NEW_META, goals: [goal('goal-2', '2026-01-20T00:00:00.000Z')]
    });

    expect(result).toEqual({ applied: false, count: 0 });
    expect(await readLocal()).toMatchObject({ birthDate: OLD_META.birthDate });
  });

  it('never lets a malformed document clock win', async () => {
    const result = await dataSync.applyRemote('goals', {
      ...NEW_META, goals: [], updatedAt: 'not-a-timestamp'
    });

    expect(result).toEqual({ applied: false, count: 0 });
    expect(await readLocal()).toMatchObject({ birthDate: OLD_META.birthDate, updatedAt: '2026-01-10T00:00:00.000Z' });
  });
});
