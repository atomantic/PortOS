import { once } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerBootHooks } from '../bootHooks.js';
import { musicVideoEvents } from './events.js';

// A background advance fails (getProject rejects), then the halt write fails
// too. The halt failure must be logged, not swallowed (#11451).
const h = vi.hoisted(() => ({ getProject: vi.fn(), mutate: vi.fn() }));

vi.mock('./projects.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProject: h.getProject,
  mutateProjectRecord: h.mutate,
}));

it.each([
  ['excerpt-render', { excerptId: 'draft', status: 'complete' }, {}, /review attempt limit/],
  ['scene-image', { sceneId: 'scene' }, { review: { verdict: 'revise' }, revisionId: 'revision' }, /revised draft failed/],
  ['scene-video', { sceneId: 'scene' }, { review: { verdict: 'revise' }, revisionId: 'revision' }, /revised draft failed/],
])('advances a persisted run once when %s arrives after boot', async (event, payload, attempt, stopReason) => {
  const projectId = 'proj-1';
  const project = {
    id: projectId,
    excerpts: [{ id: 'draft', status: 'complete' }],
    revisions: [{
      id: 'revision', status: 'open', renderAttempts: 10, error: 'Example render failure',
      sections: [{ sceneId: 'scene', verdict: 'rejected' }],
    }],
    autoReviews: [{
      id: 'run-1', status: 'running', limits: { maxAttempts: 1 }, usage: { reviews: 1 },
      attempts: [{ excerptId: 'draft', ...attempt }],
    }],
  };
  h.getProject.mockReset().mockResolvedValue(project);
  h.mutate.mockReset().mockImplementation(async (_id, transform) => transform(project));
  registerBootHooks();
  registerBootHooks();

  const advanced = once(musicVideoEvents, 'auto-review');
  expect(musicVideoEvents.emit(event, { projectId, ...payload })).toBe(true);
  expect(await advanced).toEqual([expect.objectContaining({
    projectId, run: expect.objectContaining({ id: 'run-1', stopReason: expect.stringMatching(stopReason) }),
  })]);

  const { __testing } = await import('./autoReviewService.js');
  await __testing.settleBackground();
  expect(h.getProject).toHaveBeenCalledTimes(2); // Match the event, then read the run for the advance.
  expect(h.mutate).toHaveBeenCalledOnce();
});

describe('background auto-review halt failure logging (#11451)', () => {
  let errorSpy;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.getProject.mockReset().mockRejectedValue(new Error('primary boom'));
    // First write is the resume itself; the second is the halt, which fails.
    h.mutate.mockReset()
      .mockResolvedValueOnce({ project: { id: 'proj-1' }, run: { id: 'run-1' } })
      .mockRejectedValueOnce(new Error('halt boom'));
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logs the primary step failure and the secondary halt failure with ids', async () => {
    const { resumeAutoReview, __testing } = await import('./autoReviewService.js');
    await resumeAutoReview('proj-1', 'run-1');
    await __testing.settleBackground();

    const lines = errorSpy.mock.calls.map((args) => args.join(' '));
    expect(lines.some((l) => l.startsWith('❌') && l.includes('step failed: primary boom'))).toBe(true);
    expect(lines.some((l) =>
      l.startsWith('❌') && l.includes('halt after step failure failed')
      && l.includes('projectId=proj-1') && l.includes('runId=run-1') && l.includes('halt boom'))).toBe(true);
  });
});
