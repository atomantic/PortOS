/**
 * Music Video dispatcher — peer-sync record-event wiring (#1770). Asserts the
 * dispatcher fires the recordEvents emits (announce on create, updated on every
 * structural mutator, deleted on tombstone) so a project federates after a local
 * edit. The backend is exercised for real via the file backend (NODE_ENV=test);
 * only recordEvents is mocked so we can spy on the emits.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'mv-projects-dispatch-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const emitRecordUpdated = vi.fn();
const emitRecordDeleted = vi.fn();
const autoSubscribeRecordToAllPeers = vi.fn(async () => {});
vi.mock('../sharing/recordEvents.js', () => ({
  emitRecordUpdated: (...a) => emitRecordUpdated(...a),
  emitRecordDeleted: (...a) => emitRecordDeleted(...a),
  autoSubscribeRecordToAllPeers: (...a) => autoSubscribeRecordToAllPeers(...a),
}));

const projects = await import('./projects.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'music-video-projects.json'), { force: true });
  emitRecordUpdated.mockClear();
  emitRecordDeleted.mockClear();
  autoSubscribeRecordToAllPeers.mockClear();
}
beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('musicVideo dispatcher — record-event emit (#1770)', () => {
  it('announces a new project (emit updated + auto-subscribe peers)', async () => {
    const p = await projects.createProject({ name: 'A' });
    expect(emitRecordUpdated).toHaveBeenCalledWith('musicVideoProject', p.id);
    expect(autoSubscribeRecordToAllPeers).toHaveBeenCalledWith('musicVideoProject', p.id);
  });

  it('emits updated on metadata edits, analysis, and every scene mutator', async () => {
    const p = await projects.createProject({ name: 'A' });
    emitRecordUpdated.mockClear();

    await projects.updateProject(p.id, { name: 'B' });
    await projects.setProjectAnalysis(p.id, { bpm: 120, beats: [0], downbeats: [0], sections: [], durationSec: 5 });
    const s1 = await projects.addProjectScene(p.id, { prompt: 'one' });
    const s2 = await projects.addProjectScene(p.id, { prompt: 'two' });
    await projects.updateScene(p.id, s1.sceneId, { prompt: 'one-edited' });
    await projects.reorderProjectScenes(p.id, [s2.sceneId, s1.sceneId]);
    await projects.deleteScene(p.id, s2.sceneId);

    // update + analysis + 2 add + update + reorder + deleteScene = 7 structural emits
    expect(emitRecordUpdated).toHaveBeenCalledTimes(7);
    expect(emitRecordUpdated.mock.calls.every(([kind, id]) => kind === 'musicVideoProject' && id === p.id)).toBe(true);
    expect(emitRecordDeleted).not.toHaveBeenCalled();
  });

  it('addProjectScenes bulk-appends, emits exactly one updated (not one per scene), and returns the freshly-persisted project', async () => {
    const p = await projects.createProject({ name: 'A' });
    emitRecordUpdated.mockClear();

    const { project, scenes } = await projects.addProjectScenes(p.id, [{ prompt: 'one' }, { prompt: 'two' }, { prompt: 'three' }]);

    expect(scenes).toHaveLength(3);
    expect(scenes.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(project.scenes).toHaveLength(3);
    expect(emitRecordUpdated).toHaveBeenCalledTimes(1);
    expect(emitRecordUpdated).toHaveBeenCalledWith('musicVideoProject', p.id);

    const fresh = await projects.getProject(p.id);
    expect(fresh.scenes).toHaveLength(3);
  });

  it('emits deleted on soft-delete (tombstone federates)', async () => {
    const p = await projects.createProject({ name: 'A' });
    emitRecordDeleted.mockClear();
    await projects.deleteProject(p.id);
    expect(emitRecordDeleted).toHaveBeenCalledWith('musicVideoProject', p.id);
  });

  it('re-exports the federation merge/prune helpers for peerSync + GC', async () => {
    expect(typeof projects.mergeProjectsFromSync).toBe('function');
    expect(typeof projects.pruneTombstonedProjects).toBe('function');
    expect(typeof projects.listProjectIds).toBe('function');
  });
});
