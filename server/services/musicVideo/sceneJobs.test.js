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
      { jobId: 'b', lane: 'video', sceneId: 's2', status: 'queued', label: 'local' },
    ]);
  });

  it('names where each clip renders, so a shot rendering on two providers shows both', () => {
    const tag = { musicVideo: { projectId: 'p1', sceneId: 's1' } };
    jobs.list = [
      job({ id: 'local', kind: 'video', params: { ...tag, mode: 'image' } }),
      job({ id: 'grok', kind: 'video', status: 'queued', params: { ...tag, mode: 'grok' } }),
      job({ id: 'peer', kind: 'video', params: { ...tag, mode: 'fal', remoteMedia: { wireVersion: 1 } } }),
    ];
    expect(listInFlightSceneJobs('p1').map((j) => [j.jobId, j.sceneId, j.label])).toEqual([
      ['local', 's1', 'local'], ['grok', 's1', 'grok'], ['peer', 's1', 'peer'],
    ]);
  });
});
