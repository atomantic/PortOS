import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ jobs: new Map() }));

vi.mock('./jobStore.js', () => ({
  isCodeAnimationJobId: (id) => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id),
  getCodeAnimationJobRecord: vi.fn(async (id) => store.jobs.get(id) ?? null),
  saveCodeAnimationJobRecord: vi.fn(async (job) => { store.jobs.set(job.id, job); return job; }),
}));
vi.mock('../socket.js', () => ({ emitCodeAnimationChanged: vi.fn() }));

import { ensureCodeAnimationSoundtrackTrack, startCodeAnimationSoundtrack } from './soundtrack.js';

const ID = '00000000-0000-4000-8000-000000000001';
const completedJob = () => ({
  id: ID,
  status: 'completed',
  title: 'Neon Drift',
  input: { concept: 'drift' },
  frame: { durationSeconds: 8 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const engine = { id: 'ace', name: 'ACE', minDurationSec: 1, maxDurationSec: 600 };
const baseDeps = () => ({
  getEngine: async () => engine,
  isEngineHealthy: async () => true,
  getTrack: async () => null,
  createTrack: async () => ({ id: 'track-1' }),
  queueGeneration: async () => ({ jobId: 'media-1' }),
});

beforeEach(() => {
  store.jobs.clear();
  store.jobs.set(ID, completedJob());
});

describe('Code Animation soundtrack writes after a delete', () => {
  it('does not re-create a job deleted while the soundtrack render was being queued', async () => {
    const deps = { ...baseDeps(), queueGeneration: async () => { store.jobs.delete(ID); return { jobId: 'media-1' }; } };
    await expect(startCodeAnimationSoundtrack(ID, { engine: 'ace', prompt: 'x', instrumentalOnly: true }, deps))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(store.jobs.has(ID)).toBe(false);
  });

  it('does not re-create a job deleted while the soundtrack track was being created', async () => {
    const deps = { ...baseDeps(), createTrack: async () => { store.jobs.delete(ID); return { id: 'track-1' }; } };
    await expect(ensureCodeAnimationSoundtrackTrack(ID, deps))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(store.jobs.has(ID)).toBe(false);
  });

  it('keeps a field written while the render was being queued', async () => {
    const deps = {
      ...baseDeps(),
      queueGeneration: async () => {
        store.jobs.set(ID, { ...store.jobs.get(ID), title: 'Renamed mid-render' });
        return { jobId: 'media-1' };
      },
    };
    const soundtrack = await startCodeAnimationSoundtrack(ID, { engine: 'ace', prompt: 'x', instrumentalOnly: true }, deps);
    expect(soundtrack.mediaJobId).toBe('media-1');
    const saved = store.jobs.get(ID);
    expect(saved.title).toBe('Renamed mid-render');
    expect(saved.soundtrack).toMatchObject({ trackId: 'track-1', mediaJobId: 'media-1' });
  });
});
