import { describe, it, expect } from 'vitest';
import { reviewFrameLabel, summarizeReviewProgress, REVIEW_STEP_LABELS } from './seriesReviewProgress.js';

describe('reviewFrameLabel', () => {
  it('labels each step frame from the step table', () => {
    expect(reviewFrameLabel({ type: 'step:start', kind: 'foundation' })).toBe('Judging foundation…');
    expect(reviewFrameLabel({ type: 'step:complete', kind: 'canon' })).toBe('Checking canon descriptions done');
  });

  it('marks a failed pass as failed, not done', () => {
    expect(reviewFrameLabel({ type: 'step:complete', kind: 'canon', failed: true })).toBe('Checking canon descriptions failed');
    expect(reviewFrameLabel({ type: 'step:complete', kind: 'canon', failed: false })).toBe('Checking canon descriptions done');
  });

  it('falls back to the raw kind for an unknown step', () => {
    expect(reviewFrameLabel({ type: 'step:start', kind: 'mystery' })).toBe('mystery…');
  });

  it('labels the editorial-check frames with their count', () => {
    expect(reviewFrameLabel({ type: 'check:start', label: 'Pacing' })).toBe('Editorial check: Pacing…');
    expect(reviewFrameLabel({ type: 'check:complete', label: 'Pacing', count: 3 })).toBe('Editorial check: Pacing — 3 finding(s)');
    expect(reviewFrameLabel({ type: 'check:complete', checkId: 'pacing' })).toBe('Editorial check: pacing — 0 finding(s)');
  });

  it('labels the terminal frames and tolerates a null frame', () => {
    expect(reviewFrameLabel({ type: 'complete' })).toBe('Review complete');
    expect(reviewFrameLabel({ type: 'canceled' })).toBe('Review canceled');
    expect(reviewFrameLabel({ type: 'error', error: 'boom' })).toBe('Review failed — boom');
    expect(reviewFrameLabel(null)).toBeNull();
  });
});

describe('summarizeReviewProgress', () => {
  it('returns a null headline before any frame arrives', () => {
    expect(summarizeReviewProgress([])).toEqual({ headline: null, alsoRunning: [] });
    expect(summarizeReviewProgress(undefined)).toEqual({ headline: null, alsoRunning: [] });
  });

  it('gives the headline to the only step in flight', () => {
    const s = summarizeReviewProgress([
      { type: 'start' },
      { type: 'step:start', kind: 'foundation' },
    ]);
    expect(s.headline).toBe('Judging foundation…');
    expect(s.alsoRunning).toEqual([]);
  });

  // The #4108 concurrency: foundation + canon are kicked off at entry, so their
  // frames interleave with the editorial checks' per-check frames.
  it('keeps the headline on the current editorial check while background passes run', () => {
    const s = summarizeReviewProgress([
      { type: 'step:start', kind: 'foundation' },
      { type: 'step:start', kind: 'canon' },
      { type: 'step:start', kind: 'editorialChecks' },
      { type: 'check:start', label: 'Pacing' },
      { type: 'step:complete', kind: 'canon' },
      { type: 'check:complete', label: 'Pacing', count: 2 },
      { type: 'check:start', label: 'Continuity' },
    ]);
    expect(s.headline).toBe('Editorial check: Continuity…');
    // Canon settled mid-pass, so only the still-running foundation is reported.
    expect(s.alsoRunning).toEqual(['Judging foundation']);
  });

  it('does not let a settled background step steal the headline', () => {
    const s = summarizeReviewProgress([
      { type: 'step:start', kind: 'foundation' },
      { type: 'step:start', kind: 'editorialChecks' },
      { type: 'check:start', label: 'Pacing' },
      { type: 'step:complete', kind: 'foundation', weightedScore: 8 },
    ]);
    expect(s.headline).toBe('Editorial check: Pacing…');
    expect(s.alsoRunning).toEqual([]);
  });

  it('falls back to the checks step itself before its first check frame', () => {
    const s = summarizeReviewProgress([
      { type: 'step:start', kind: 'foundation' },
      { type: 'step:start', kind: 'editorialChecks' },
    ]);
    expect(s.headline).toBe('Running editorial checks…');
    expect(s.alsoRunning).toEqual(['Judging foundation']);
  });

  it('moves to the health step once the checks pass completes', () => {
    const s = summarizeReviewProgress([
      { type: 'step:start', kind: 'foundation' },
      { type: 'step:start', kind: 'editorialChecks' },
      { type: 'check:complete', label: 'Pacing', count: 0 },
      { type: 'step:complete', kind: 'editorialChecks' },
      { type: 'step:start', kind: 'health' },
    ]);
    expect(s.headline).toBe('Scoring editorial health…');
    expect(s.alsoRunning).toEqual(['Judging foundation']);
  });

  it('shows the newest frame when nothing is in flight between steps', () => {
    const s = summarizeReviewProgress([
      { type: 'step:start', kind: 'feedback' },
      { type: 'step:complete', kind: 'feedback' },
    ]);
    expect(s.headline).toBe('Routing your feedback done');
    expect(s.alsoRunning).toEqual([]);
  });

  it('a terminal frame always wins, even with steps still marked in flight', () => {
    const s = summarizeReviewProgress([
      { type: 'step:start', kind: 'foundation' },
      { type: 'complete', verdict: 'issues' },
    ]);
    expect(s).toEqual({ headline: 'Review complete', alsoRunning: [] });
  });

  it('ignores non-object entries in the frame list', () => {
    const s = summarizeReviewProgress([null, 'nope', { type: 'step:start', kind: 'canon' }]);
    expect(s.headline).toBe(`${REVIEW_STEP_LABELS.canon}…`);
  });
});
// @vitest-environment node
