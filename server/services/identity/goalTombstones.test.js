import { describe, it, expect } from 'vitest';
import { reconcileGoalTombstones, tombstoneGoal } from './goalTombstones.js';

const goal = (id, parentId = null, updatedAt = '2026-01-01T00:00:00.000Z') => ({ id, parentId, updatedAt });
const tombstone = (id, deletedAt = '2026-01-05T00:00:00.000Z') => ({ id, deletedAt });

// The cases the offline-peer cycle in goalDeletionSync.test.js cannot reach
// cheaply: ancestor chains, a corrupt cycle, and a parent record this side lost.
describe('reconcileGoalTombstones', () => {
  it('re-parents a survivor to the nearest ancestor that is still alive', () => {
    const { goals } = reconcileGoalTombstones(
      [goal('root'), goal('mid', 'root'), goal('leaf', 'mid'), goal('child', 'leaf')],
      [tombstone('mid'), tombstone('leaf')],
    );
    expect(goals.map((g) => g.id)).toEqual(['root', 'child']);
    expect(goals[1]).toMatchObject({ parentId: 'root', updatedAt: '2026-01-05T00:00:00.000Z' });
  });

  it('terminates on a corrupt parent cycle and detaches to the root', () => {
    const { goals } = reconcileGoalTombstones(
      [goal('a', 'b'), goal('b', 'a'), goal('child', 'a')],
      [tombstone('a'), tombstone('b')],
    );
    expect(goals).toEqual([expect.objectContaining({ id: 'child', parentId: null })]);
  });

  it('leaves a child alone when the deleted parent record is not held here', () => {
    const child = goal('child', 'gone');
    const { goals, tombstones } = reconcileGoalTombstones([child], [tombstone('gone')]);
    expect(goals).toEqual([child]);
    expect(tombstones).toEqual([tombstone('gone')]);
  });

  it('stamps a re-parent past a child that was edited after the deletion', () => {
    const { goals } = reconcileGoalTombstones(
      [goal('parent'), goal('child', 'parent', '2026-01-06T00:00:00.000Z')],
      [tombstone('parent')],
    );
    expect(goals).toEqual([expect.objectContaining({ parentId: null, updatedAt: '2026-01-06T00:00:00.001Z' })]);
  });
});

describe('tombstoneGoal', () => {
  it('stamps the deletion past a goal edited by a peer whose clock ran ahead', () => {
    const doc = { goals: [] };
    tombstoneGoal(doc, { id: 'g', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }, '2026-02-01T00:00:00.000Z');
    expect(doc.goalTombstones).toEqual([tombstone('g', '2026-03-01T00:00:00.001Z')]);
  });

  it('ignores a goal without an id rather than writing a keyless tombstone', () => {
    const doc = {};
    tombstoneGoal(doc, { title: 'No id' });
    expect(doc).toEqual({});
  });
});
