import { describe, expect, it } from 'vitest';
import { musicVideoCompletionBlocker, musicVideoCompletionOverride } from './musicVideoCompletion.js';
import { isMusicVideoCompleted } from './musicVideoSummary.js';

const markedAt = '2026-01-02T00:00:00.000Z';
const stale = { status: 'complete', renderHistoryId: 'r1', renderDependencyState: { status: 'stale', reasons: ['x'] } };

describe('music video completion mark', () => {
  it('lets the director decide over the final render evidence', () => {
    expect(isMusicVideoCompleted(stale)).toBe(false);
    expect(isMusicVideoCompleted({ ...stale, completion: { state: 'complete', markedAt } })).toBe(true);
    expect(isMusicVideoCompleted({ status: 'complete', renderHistoryId: 'r1', completion: { state: 'in-progress', markedAt } })).toBe(false);
  });

  it('counts a complete mark only while there is a final render, and ignores a malformed one', () => {
    expect(musicVideoCompletionOverride({ completion: { state: 'complete', markedAt } })).toBeNull();
    expect(musicVideoCompletionOverride({ renderHistoryId: 'r1', completion: { state: 'done', markedAt } })).toBeNull();
    expect(musicVideoCompletionOverride({ renderHistoryId: 'r1', completion: { state: 'complete' } })).toBeNull();
    expect(musicVideoCompletionOverride({ renderHistoryId: 'r1' })).toBeNull();
    expect(musicVideoCompletionBlocker({}, 'complete')).toMatch(/final video/);
    expect(musicVideoCompletionBlocker({}, 'in-progress')).toBeNull();
    expect(musicVideoCompletionBlocker({ renderHistoryId: 'r1' }, 'complete')).toBeNull();
  });
});
