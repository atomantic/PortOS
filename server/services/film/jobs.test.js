import { afterEach, expect, it } from 'vitest';
import { listActiveRenders } from '../renderActivity.js';
import { __resetBlenderJobsForTests, createBlenderJob, updateBlenderJob } from './jobs.js';

afterEach(__resetBlenderJobsForTests);

it('counts a film job as live work only while it runs', () => {
  const owner = { kind: 'music-video', id: 'proj-1', emit: () => {} };
  const entry = createBlenderJob(owner, { kind: 'render', shotId: 'shot-1', quality: 'final' });
  expect(listActiveRenders()).toEqual([]);
  updateBlenderJob(entry, { status: 'running' });
  updateBlenderJob(entry, { index: 4, total: 10 });
  expect(listActiveRenders()).toEqual([expect.objectContaining({ kind: 'film', to: '/music-video/proj-1' })]);
  updateBlenderJob(entry, { status: 'error', error: 'Render failed' });
  expect(listActiveRenders()).toEqual([]);
});
