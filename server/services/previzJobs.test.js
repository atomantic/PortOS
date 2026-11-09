import { beforeEach, expect, it, vi } from 'vitest';
import { __resetPrevizJobsForTests, finishPrevizJob, listPrevizJobs, startPrevizJob } from './previzJobs.js';
import { catalogEvents } from './catalogEvents.js';

beforeEach(() => { __resetPrevizJobsForTests(); vi.useRealTimers(); });

// Catches a browser-side build that never shows up for another tab, or one that never settles with its outcome.
it('tracks a reported build, broadcasts both edges and settles it once', () => {
  const frames = [];
  const onJobs = (snapshot) => frames.push(snapshot.jobs.map((job) => job.state));
  catalogEvents.on('previz-jobs', onJobs);
  const id = startPrevizJob({ kind: 'build', projectId: 'mv-1', label: 'Build previz' });
  expect(listPrevizJobs().jobs).toEqual([expect.objectContaining({ id, kind: 'build', projectId: 'mv-1', state: 'running' })]);
  expect(finishPrevizJob(id, { summary: '3 cuts added' })).toBe(true);
  expect(finishPrevizJob(id)).toBe(false);
  catalogEvents.off('previz-jobs', onJobs);
  expect(frames).toEqual([['running'], ['done']]);
  expect(listPrevizJobs().jobs).toEqual([expect.objectContaining({ state: 'done', summary: '3 cuts added' })]);
});

// Catches an orphaned build (tab closed) disabling the Build button forever.
it('stops showing a build that stopped reporting', () => {
  const id = startPrevizJob({ kind: 'build', projectId: 'mv-1', label: 'Build previz' });
  const later = Date.now() + 11 * 60 * 1000;
  expect(listPrevizJobs(later).jobs).toEqual([expect.objectContaining({ id, state: 'failed', summary: 'Stopped reporting' })]);
});
