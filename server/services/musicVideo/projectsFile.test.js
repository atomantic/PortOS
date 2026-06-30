/**
 * Music Video file-backend round-trip (#1760). Runs against a tmpdir in the
 * normal (non-DB) suite — covers create/list/get/update/delete + the scene-board
 * mutators + analysis caching + soft-delete, without touching real `data/` or
 * needing Postgres. The PG backend shares the same projectsLogic decisions, so
 * its row I/O mirrors this.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'mv-projects-file-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const file = await import('./projectsFile.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'music-video-projects.json'), { force: true });
}
beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('projectsFile backend', () => {
  it('creates, lists, and gets a project', async () => {
    const created = await file.createProject({ name: 'MV One', trackId: 't1' });
    expect(created.id).toMatch(/^mv-/);
    const list = await file.listProjects();
    expect(list).toHaveLength(1);
    expect((await file.getProject(created.id)).name).toBe('MV One');
  });

  it('updates project metadata', async () => {
    const p = await file.createProject({ name: 'A' });
    const updated = await file.updateProject(p.id, { name: 'B', status: 'ready' });
    expect(updated.name).toBe('B');
    expect(updated.status).toBe('ready');
  });

  it('caches audio analysis and flips draft to analyzed', async () => {
    const p = await file.createProject({ name: 'A' });
    const analysis = { bpm: 128, beats: [0], downbeats: [0], sections: [], durationSec: 10 };
    const updated = await file.setProjectAnalysis(p.id, analysis);
    expect(updated.audioAnalysis).toEqual(analysis);
    expect(updated.status).toBe('analyzed');
  });

  it('runs the full scene-board lifecycle', async () => {
    const p = await file.createProject({ name: 'A' });
    const s1 = await file.addProjectScene(p.id, { prompt: 'one' });
    const s2 = await file.addProjectScene(p.id, { prompt: 'two' });
    expect(s1.order).toBe(0);
    expect(s2.order).toBe(1);

    const upd = await file.updateScene(p.id, s1.sceneId, { prompt: 'one-edited' });
    expect(upd.prompt).toBe('one-edited');

    let proj = await file.reorderProjectScenes(p.id, [s2.sceneId, s1.sceneId]);
    expect(proj.scenes.map((s) => s.sceneId)).toEqual([s2.sceneId, s1.sceneId]);

    proj = await file.deleteScene(p.id, s2.sceneId);
    expect(proj.scenes).toHaveLength(1);
    expect(proj.scenes[0].order).toBe(0);
  });

  it('soft-deletes a project (tombstone hidden from live list)', async () => {
    const p = await file.createProject({ name: 'A' });
    await file.deleteProject(p.id);
    expect(await file.listProjects()).toHaveLength(0);
    expect(await file.getProject(p.id)).toBeNull();
    expect(await file.listProjects({ includeDeleted: true })).toHaveLength(1);
  });

  it('404s mutating a deleted project (no resurrection)', async () => {
    const p = await file.createProject({ name: 'A' });
    await file.deleteProject(p.id);
    await expect(file.updateProject(p.id, { name: 'X' })).rejects.toThrow(/not found/i);
    await expect(file.addProjectScene(p.id, { prompt: 'x' })).rejects.toThrow(/not found/i);
  });
});

describe('projectsFile federation (#1770)', () => {
  it('listProjectIds returns live ids, or all when includeDeleted', async () => {
    const a = await file.createProject({ name: 'A' });
    const b = await file.createProject({ name: 'B' });
    await file.deleteProject(b.id);
    expect(await file.listProjectIds()).toEqual([a.id]);
    expect((await file.listProjectIds({ includeDeleted: true })).sort()).toEqual([a.id, b.id].sort());
  });

  it('mergeProjectsFromSync inserts a brand-new peer record', async () => {
    const remote = { id: 'mv-peer-1', name: 'Peer', status: 'draft', updatedAt: '2026-02-01T00:00:00Z', createdAt: '2026-02-01T00:00:00Z', scenes: [] };
    const res = await file.mergeProjectsFromSync([remote]);
    expect(res).toEqual({ applied: true, count: 1 });
    expect((await file.getProject('mv-peer-1')).name).toBe('Peer');
  });

  it('mergeProjectsFromSync applies a newer remote and ignores an older one', async () => {
    const p = await file.createProject({ name: 'Local' });
    const newer = { ...p, name: 'RemoteNewer', updatedAt: '2099-01-01T00:00:00Z' };
    expect(await file.mergeProjectsFromSync([newer])).toEqual({ applied: true, count: 1 });
    expect((await file.getProject(p.id)).name).toBe('RemoteNewer');

    const older = { ...p, name: 'RemoteOlder', updatedAt: '2000-01-01T00:00:00Z' };
    expect(await file.mergeProjectsFromSync([older])).toEqual({ applied: false, count: 0 });
    expect((await file.getProject(p.id)).name).toBe('RemoteNewer');
  });

  it('mergeProjectsFromSync applies a remote tombstone (delete federates)', async () => {
    const p = await file.createProject({ name: 'Doomed' });
    const tombstone = { ...p, deleted: true, deletedAt: '2099-01-01T00:00:00Z', updatedAt: '2099-01-01T00:00:00Z' };
    expect(await file.mergeProjectsFromSync([tombstone])).toEqual({ applied: true, count: 1 });
    expect(await file.getProject(p.id)).toBeNull();
    expect(await file.getProject(p.id, { includeDeleted: true })).toMatchObject({ deleted: true });
  });

  it('pruneTombstonedProjects hard-removes only old-enough tombstones', async () => {
    const keep = await file.createProject({ name: 'Live' });
    // Insert an already-old tombstone via the sync insert path (insert applies
    // regardless of LWW), so its deletedAt sits far enough in the past to prune.
    await file.mergeProjectsFromSync([{
      id: 'mv-old-tomb', name: 'Old', status: 'draft', scenes: [],
      createdAt: '2000-01-01T00:00:00Z', updatedAt: '2000-01-02T00:00:00Z',
      deleted: true, deletedAt: '2000-01-01T00:00:00Z',
    }]);

    // A future cutoff prunes the old tombstone; a pre-tombstone cutoff would not.
    expect((await file.pruneTombstonedProjects(Date.parse('1990-01-01T00:00:00Z'))).pruned).toBe(0);
    const res = await file.pruneTombstonedProjects(Date.parse('2010-01-01T00:00:00Z'));
    expect(res.pruned).toBe(1);
    expect(await file.listProjectIds({ includeDeleted: true })).toEqual([keep.id]);
  });
});
