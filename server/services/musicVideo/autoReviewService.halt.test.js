import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A background advance fails (getProject rejects), then the halt write fails
// too. The halt failure must be logged, not swallowed (#11451).
const h = vi.hoisted(() => ({ getProject: vi.fn(), mutate: vi.fn() }));

vi.mock('./projects.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getProject: h.getProject,
  mutateProjectRecord: h.mutate,
}));

const { resumeAutoReview, __testing } = await import('./autoReviewService.js');

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
    await resumeAutoReview('proj-1', 'run-1');
    await __testing.settleBackground();

    const lines = errorSpy.mock.calls.map((args) => args.join(' '));
    expect(lines.some((l) => l.startsWith('❌') && l.includes('step failed: primary boom'))).toBe(true);
    expect(lines.some((l) =>
      l.startsWith('❌') && l.includes('halt after step failure failed')
      && l.includes('projectId=proj-1') && l.includes('runId=run-1') && l.includes('halt boom'))).toBe(true);
  });
});
