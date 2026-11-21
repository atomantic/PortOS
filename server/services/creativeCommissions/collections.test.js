import { afterAll, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

// Real collection and Creative Director stores over a temp data root; only the
// commission list is stubbed.
vi.mock('../../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-commission-collections-') }));
afterAll(cleanupTempDataRoots);
vi.mock('../instances.js', async (importOriginal) => ({ ...(await importOriginal()), getPeers: vi.fn(async () => []) }));
const listCommissions = vi.fn(async () => [{ id: 'commission-daily', name: 'Daily Video' }]);
vi.mock('./store.js', () => ({ listCommissions: (...a) => listCommissions(...a) }));

const { consolidateCommissionCollections } = await import('./collections.js');
const { createProject, getProject } = await import('../creativeDirector/local.js');
const collections = await import('../mediaCollections.js');

const PROJECT = { aspectRatio: '16:9', quality: 'standard', modelId: 'example-model', targetDurationSeconds: 10 };

describe('consolidateCommissionCollections', () => {
  it('folds every dated run collection and same-named strays into one job collection', async () => {
    const runA = await createProject({ ...PROJECT, name: 'Daily Video — 2026-07-16', commissionId: 'commission-daily' });
    const runB = await createProject({ ...PROJECT, name: 'Daily Video — 2026-07-17', commissionId: 'commission-daily' });
    const solo = await createProject({ ...PROJECT, name: 'Unrelated' });
    // A standalone project that happens to share the job's name keeps its own collection.
    const namesake = await createProject({ ...PROJECT, name: 'Daily Video' });
    await collections.addItem(runA.collectionId, { kind: 'video', ref: 'clip-a' });
    await collections.addItem(runB.collectionId, { kind: 'video', ref: 'clip-b' });
    const stray = await collections.createCollection({ name: 'Creative Director: Daily Video' });
    await collections.addItem(stray.id, { kind: 'video', ref: 'clip-c' });

    expect(await consolidateCommissionCollections()).toEqual({ jobs: 1, mergedCollections: 3, repointedProjects: 0, failedJobs: 0 });

    const live = await collections.listCollections();
    const job = live.find((c) => c.id === 'cdc-commission-daily');
    expect(job.name).toBe('Creative Director: Daily Video');
    expect(job.items.map((i) => i.ref).sort()).toEqual(['clip-a', 'clip-b', 'clip-c']);
    expect(live.filter((c) => c.name.startsWith('Creative Director: Daily Video') && c.id !== namesake.collectionId)).toHaveLength(1);
    expect((await getProject(runA.id)).collectionId).toBe(job.id);
    expect((await getProject(runB.id)).collectionId).toBe(job.id);
    expect((await getProject(solo.id)).collectionId).toBe(solo.collectionId);
    expect((await getProject(namesake.id)).collectionId).toBe(namesake.collectionId);
    expect(live.some((c) => c.id === namesake.collectionId)).toBe(true);

    expect(await consolidateCommissionCollections()).toEqual({ jobs: 1, mergedCollections: 0, repointedProjects: 0, failedJobs: 0 });
  });
});
