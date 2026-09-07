/**
 * Creative Director file-backend federation merge (#1564) — soft-delete,
 * LWW merge, tombstone prune, and the conflict-journal + base-hash wiring.
 *
 * Mirrors authors/file.test.js: runs against a tmpdir in the normal (non-DB)
 * suite, so it covers the project-specific sync side effects (`setSyncBaseHash`
 * seeding on insert, `maybeJournalBeforeOverwrite` archiving the losing local
 * version on a true 3-way divergence, soft-delete tombstone, prune eviction)
 * without touching real `data/` or needing Postgres. The Postgres backend shares
 * the same `mergeProjectRecord` decision, so its round-trip in projectsDB.test.js
 * doesn't need to re-pin these.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'cd-projects-file-test-'));
const writeCounter = vi.hoisted(() => ({ project: 0, baseHash: 0 }));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT },
    atomicWrite: async (path, data) => {
      if (typeof path === 'string' && path.endsWith('creative-director-projects.json')) writeCounter.project += 1;
      if (typeof path === 'string' && path.endsWith('sync_base_hashes.json')) writeCounter.baseHash += 1;
      return actual.atomicWrite(path, data);
    },
  };
});
// createProject would otherwise spin up the full media stack; we only test the
// federation paths here, none of which create a collection.
vi.mock('../mediaCollections.js', () => ({
  createCollection: vi.fn(async () => ({ id: 'col-test' })),
}));

const file = await import('./projectsFile.js');
const cj = await import('../../lib/conflictJournal.js');

function reset() {
  rmSync(join(TEST_DATA_ROOT, 'creative-director-projects.json'), { force: true });
  rmSync(join(TEST_DATA_ROOT, 'sharing'), { recursive: true, force: true });
  rmSync(join(TEST_DATA_ROOT, 'conflict-journal'), { recursive: true, force: true });
  cj.__resetBaseHashCacheForTests();
  writeCounter.project = 0;
  writeCounter.baseHash = 0;
}
beforeEach(reset);
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

const project = (id, extra = {}) => ({
  id,
  name: `P-${id}`,
  status: 'draft',
  createdAt: '2026-06-23T00:00:00.000Z',
  updatedAt: '2026-06-23T00:00:00.000Z',
  styleSpec: '',
  treatment: null,
  runs: [],
  deleted: false,
  deletedAt: null,
  ...extra,
});
const journalEntries = () => cj.conflictJournalStore().loadAll();

describe('projectsFile federation merge', () => {
  it('bounds Video targets on create and range edits and preserves them across reload', async () => {
    const p = await file.createProject({ name: 'Example short', workspace: 'video', modelId: '', aspectRatio: '16:9', quality: 'draft', targetDurationSeconds: 240, videoDraft: { durationRange: { min: 60, max: 180 } } });
    expect(p.targetDurationSeconds).toBe(180);
    await file.updateProject(p.id, { targetDurationSeconds: 120 });
    await file.updateProject(p.id, { name: 'Revised short', videoDraft: { ...p.videoDraft, durationRange: { min: 60, max: 150 } } });
    expect((await file.getProject(p.id)).targetDurationSeconds).toBe(120);
    await file.updateProject(p.id, { videoDraft: { ...p.videoDraft, durationRange: { min: 130, max: 150 } } });
    expect((await file.getProject(p.id)).targetDurationSeconds).toBe(130);
    const legacy = await file.createProject({ name: 'Legacy project', modelId: '', aspectRatio: '16:9', quality: 'draft', targetDurationSeconds: 240 });
    expect((await file.getProject(legacy.id)).targetDurationSeconds).toBe(240);
  });

  it('keeps the saved plan and completed results when a replan removes a required producer', async () => {
    const p = await file.createProject({ name: 'Example production', modelId: 'example', aspectRatio: '16:9', quality: 'draft', targetDurationSeconds: 60 });
    const producer = { stepId: 'source', toolName: 'pipeline_createSeries' };
    const consumer = { stepId: 'consumer', toolName: 'pipeline_generateStage', dependsOn: ['source'] };
    await file.setPlan(p.id, { steps: [producer, consumer] });
    await file.updatePlanStep(p.id, 'source', { status: 'done', result: { id: 'example-series' } });
    const saved = await file.getProject(p.id);
    const writesBefore = writeCounter.project;
    await expect(file.setPlan(p.id, { steps: [consumer] })).rejects.toThrow('Unknown dependency: source');
    expect(writeCounter.project).toBe(writesBefore);
    expect(await file.getProject(p.id)).toEqual(saved);
    const revised = await file.setPlan(p.id, { steps: [consumer, producer] });
    expect(revised.plan.replanRounds).toBe(1);
    expect(revised.plan.steps[1]).toMatchObject({ status: 'done', result: { id: 'example-series' } });
  });

  it('persists Video draft preferences and prevents removing the workspace barrier', async () => {
    const p = await file.createProject({
      name: 'Example short', workspace: 'video', modelId: '', aspectRatio: '16:9',
      quality: 'draft', targetDurationSeconds: 60,
    });
    expect(p.videoDraft.checkpoints).toEqual(['script-shot-plan', 'references', 'rough-cut', 'final-cut']);
    const videoDraft = {
      ...p.videoDraft, durationRange: { min: 60, max: 180 },
      sources: [{ kind: 'universe', id: 'example-universe', revision: 'r1' }],
      audio: { providerId: 'example-audio', model: 'example-model' },
    };
    await file.updateProject(p.id, { userStory: 'Example brief', videoDraft });
    expect(await file.getProject(p.id)).toMatchObject({
      id: p.id, workspace: 'video', status: 'draft', userStory: 'Example brief', videoDraft,
    });
    await expect(file.updateProject(p.id, { workspace: undefined })).rejects.toThrow('workspace cannot be changed');
  });

  it('round-trips and clears cognitive effort through create and patch', async () => {
    const pin = { providerId: 'example-agent', model: 'example-model', effort: 'high' };
    const p = await file.createProject({ name: 'Example', modelId: 'example', aspectRatio: '1:1', quality: 'draft', targetDurationSeconds: 9, modelOverrides: { plan: pin } });

    expect((await file.getProject(p.id)).modelOverrides.plan).toEqual(pin);
    await file.updateProject(p.id, { modelOverrides: { plan: { ...pin, effort: null } } });
    expect((await file.getProject(p.id)).modelOverrides.plan).toEqual({ providerId: pin.providerId, model: pin.model });
    await file.updateProject(p.id, { modelOverrides: {} });
    expect((await file.getProject(p.id)).modelOverrides).toEqual({});
  });

  it('inserts a remote project and seeds its base hash', async () => {
    const res = await file.mergeProjectsFromSync([project('cd-1')]);
    expect(res).toEqual({ applied: true, count: 1 });
    expect(await file.getProject('cd-1')).toMatchObject({ id: 'cd-1' });
    expect(await cj.getSyncBaseHash('creativeDirectorProject', 'cd-1')).toBeTruthy();
  });

  it('journals the losing local version on a true 3-way divergence (both diverged from base)', async () => {
    // Persist a local record, then pin the synced base hash to a THIRD, different
    // version — so both the stored local and the incoming remote differ from base
    // (the 3-way-divergence precondition the journal detects). Mirrors the authors
    // file-backend journaling test.
    const local = project('cd-1', { styleSpec: 'local-edit', updatedAt: '2026-06-23T00:30:00.000Z' });
    await file.mergeProjectsFromSync([local]); // inserts local + seeds base = local's hash
    const base = project('cd-1', { styleSpec: 'common-ancestor', updatedAt: '2026-06-23T00:00:00.000Z' });
    await cj.setSyncBaseHash('creativeDirectorProject', 'cd-1', cj.contentHashForRecord('creativeDirectorProject', base));

    const remoteWinner = project('cd-1', { styleSpec: 'remote-edit', updatedAt: '2026-06-23T01:00:00.000Z' });
    const res = await file.mergeProjectsFromSync([remoteWinner], { source: { via: 'peer-push', peerId: 'peer-A' } });
    expect(res.applied).toBe(true);
    expect((await file.getProject('cd-1')).styleSpec).toBe('remote-edit');

    const entry = (await journalEntries()).find((e) => e.recordKind === 'creativeDirectorProject' && e.recordId === 'cd-1');
    expect(entry).toBeTruthy();
    expect(entry.source.peerId).toBe('peer-A');
    expect(entry.localSnapshot.styleSpec).toBe('local-edit');
    expect(entry.remoteSnapshot.styleSpec).toBe('remote-edit');
  });

  it('older remote loses — local preserved, no write', async () => {
    await file.mergeProjectsFromSync([project('cd-1', { updatedAt: '2026-06-23T02:00:00.000Z', styleSpec: 'keep' })]);
    const res = await file.mergeProjectsFromSync([project('cd-1', { updatedAt: '2026-06-23T01:00:00.000Z', styleSpec: 'stale' })]);
    expect(res).toEqual({ applied: false, count: 0 });
    expect((await file.getProject('cd-1')).styleSpec).toBe('keep');
  });

  it('same-updatedAt re-push is a no-op without project or base-hash writes', async () => {
    const remote = project('cd-1');
    await file.mergeProjectsFromSync([remote]);
    writeCounter.project = 0;
    writeCounter.baseHash = 0;

    expect(await file.mergeProjectsFromSync([remote])).toEqual({ applied: false, count: 0 });
    expect(writeCounter).toEqual({ project: 0, baseHash: 0 });
  });

  it('soft-delete tombstones the project (excluded from live reads, present with includeDeleted)', async () => {
    await file.mergeProjectsFromSync([project('cd-1')]);
    await file.deleteProject('cd-1');
    expect(await file.getProject('cd-1')).toBeNull();
    expect(await file.getProject('cd-1', { includeDeleted: true })).toMatchObject({ id: 'cd-1', deleted: true });
    expect(await file.listProjectIds()).toEqual([]);
    expect(await file.listProjectIds({ includeDeleted: true })).toEqual(['cd-1']);
  });

  it('a newer remote tombstone overwrites a live local project', async () => {
    await file.mergeProjectsFromSync([project('cd-1', { updatedAt: '2026-06-23T00:00:00.000Z' })]);
    await file.mergeProjectsFromSync([project('cd-1', { updatedAt: '2026-06-23T05:00:00.000Z', deleted: true, deletedAt: '2026-06-23T05:00:00.000Z' })]);
    expect(await file.getProject('cd-1')).toBeNull();
    expect(await file.getProject('cd-1', { includeDeleted: true })).toMatchObject({ deleted: true });
  });

  it('rejects user-facing mutators on a tombstoned project (no resurrect-then-push)', async () => {
    await file.mergeProjectsFromSync([project('cd-1')]);
    await file.deleteProject('cd-1');
    await expect(file.updateProject('cd-1', { styleSpec: 'zombie' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(file.setTreatment('cd-1', { logline: 'x', synopsis: 'y', scenes: [] })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    // Still gone (the rejected writes left no trace).
    expect(await file.getProject('cd-1', { includeDeleted: true })).toMatchObject({ deleted: true, styleSpec: '' });
  });

  it('pruneTombstonedProjects hard-removes old tombstones and evicts the base hash', async () => {
    await file.mergeProjectsFromSync([project('cd-1', { updatedAt: '2026-06-23T00:00:00.000Z', deleted: true, deletedAt: '2026-06-23T00:00:00.000Z' })]);
    const res = await file.pruneTombstonedProjects(Date.parse('2030-01-01T00:00:00.000Z'));
    expect(res.pruned).toBe(1);
    expect(await file.getProject('cd-1', { includeDeleted: true })).toBeNull();
    expect(await cj.getSyncBaseHash('creativeDirectorProject', 'cd-1')).toBeNull();
  });
});
