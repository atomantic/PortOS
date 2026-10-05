import { describe, it, expect } from 'vitest';
import { batchActive, batchSummary, scenesWaitingForFrame, videoBatchPreview, videosButtonLabel } from './musicVideoBatchPlan.js';

const scene = (order, extra = {}) => ({ sceneId: `s${order}`, order, startSec: order * 5, endSec: order * 5 + 5, ...extra });

describe('musicVideoBatchPlan', () => {
  it('sums fal takes into one estimate and counts what it cannot price', () => {
    const scenes = [scene(0), scene(1)];
    const priced = videoBatchPreview({ scenes, backend: 'fal', videoSettings: {} });
    expect(priced.count).toBe(2);
    expect(priced.costUsd).toBeGreaterThan(0);
    expect(priced.unpriced).toBe(0);
    expect(priced.text).toMatch(/^Generate 2 clips on fal \/ .* · est\. \$/);
    const uncurated = videoBatchPreview({ scenes, backend: 'fal', videoSettings: { falModelId: 'fal-ai/not-curated' } });
    expect(uncurated.unpriced).toBe(2);
    expect(uncurated.text).toContain('(2 unpriced)');
  });

  it('shows the count only for local and Grok renders', () => {
    expect(videoBatchPreview({ scenes: [scene(0)], backend: 'local', videoSettings: {} }).text).toBe('Generate 1 clip on the local renderer');
    expect(videoBatchPreview({ scenes: [scene(0), scene(1)], backend: 'grok', videoSettings: {} }).text).toBe('Generate 2 clips on Grok');
  });

  it('names the scenes waiting for a frame, ignoring ones that already have a clip', () => {
    const footage = [scene(0, { referenceImageId: 'a.png' }), scene(1, { sectionLabel: 'Chorus' }), scene(2, { videoHistoryId: 'v' })];
    const waiting = scenesWaitingForFrame(footage);
    expect(waiting.map((s) => s.sceneId)).toEqual(['s1']);
    expect(videosButtonLabel({ renderableCount: 1, footageCount: 3, waiting })).toBe('Videos 1/3 (1 waiting for a frame: Chorus)');
    expect(videosButtonLabel({ renderableCount: 3, footageCount: 3, waiting: [] })).toBe('Videos 3/3');
  });

  it('summarises a batch and knows when it is still running', () => {
    expect(batchSummary('Videos', { total: 14, done: 6, failed: 2, canceled: 0 })).toBe('Videos: 6 of 14 done · 2 failed');
    expect(batchSummary('Videos', { total: 14, done: 6, failed: 0, canceled: 8 })).toBe('Videos: 6 of 14 done · 8 canceled');
    expect(batchActive({ total: 3, done: 1, failed: 1, canceled: 0 })).toBe(true);
    expect(batchActive({ total: 3, done: 1, failed: 1, canceled: 1 })).toBe(false);
    expect(batchActive(null)).toBe(false);
  });
});
