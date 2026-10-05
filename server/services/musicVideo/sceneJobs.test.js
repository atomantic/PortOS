import { describe, it, expect, vi } from 'vitest';

const jobs = vi.hoisted(() => ({ list: [] }));
vi.mock('../mediaJobQueue/index.js', () => ({ listJobs: () => jobs.list }));

const { listInFlightSceneJobs } = await import('./sceneJobs.js');

const job = (over) => ({ id: 'j', kind: 'image', status: 'running', params: { musicVideo: { projectId: 'p1', sceneId: 's1' } }, ...over });

describe('listInFlightSceneJobs (#10154)', () => {
  it('returns only this project\'s live scene frame/clip jobs', () => {
    jobs.list = [
      job({ id: 'a', status: 'running' }),
      job({ id: 'b', kind: 'video', status: 'queued', params: { musicVideo: { projectId: 'p1', sceneId: 's2' } } }),
      job({ id: 'done', status: 'completed' }),
      job({ id: 'failed', status: 'failed' }),
      job({ id: 'other-project', params: { musicVideo: { projectId: 'p2', sceneId: 's1' } } }),
      job({ id: 'cast-sets', params: { musicVideo: { projectId: 'p1', key: 'cast-1' } } }),
      job({ id: 'untagged', params: {} }),
      job({ id: 'audio', kind: 'audio' }),
    ];
    expect(listInFlightSceneJobs('p1')).toEqual([
      { jobId: 'a', lane: 'image', sceneId: 's1', status: 'running' },
      { jobId: 'b', lane: 'video', sceneId: 's2', status: 'queued' },
    ]);
  });
});
