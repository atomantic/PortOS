import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory file store so reads/writes round-trip without touching disk.
const fileStore = new Map();
vi.mock('../../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

// seriesStore().recordDir(id) → a stable per-series path key.
vi.mock('./series.js', () => ({
  seriesStore: () => ({ recordDir: (id) => `/mock/series/${id}` }),
}));

// No manuscript sections needed for these tests (seed resolves issueId/stageId
// from them, but we don't assert on those here).
vi.mock('./arcPlanner.js', () => ({
  collectManuscriptSections: vi.fn(async () => []),
}));

import { recordEvents } from '../sharing/recordEvents.js';
import { seedReviewFromFindings, updateComment, mergeReviewFromSync } from './manuscriptReview.js';

describe('manuscriptReview — record-event emission on write', () => {
  let updates;
  let listener;
  beforeEach(() => {
    fileStore.clear();
    updates = [];
    listener = (evt) => updates.push(evt);
    recordEvents.on('updated', listener);
  });
  afterEach(() => {
    recordEvents.off('updated', listener);
  });

  it('seedReviewFromFindings emits a series updated event when comments are added', async () => {
    await seedReviewFromFindings('ser-1', [{ problem: 'Act II sags', anchorQuote: 'the road' }]);
    expect(updates).toContainEqual({ recordKind: 'series', recordId: 'ser-1' });
  });

  it('seedReviewFromFindings does NOT emit when no fresh findings are added', async () => {
    // Seed once, then re-seed the identical finding — the second call is a no-op
    // (deduped by finding key) and must not fire a spurious push/re-export.
    await seedReviewFromFindings('ser-1', [{ problem: 'Act II sags', anchorQuote: 'the road' }]);
    updates.length = 0;
    await seedReviewFromFindings('ser-1', [{ problem: 'Act II sags', anchorQuote: 'the road' }]);
    expect(updates).toEqual([]);
  });

  it('updateComment emits a series updated event', async () => {
    const seeded = await seedReviewFromFindings('ser-2', [{ problem: 'Pacing', anchorQuote: 'q' }]);
    const commentId = seeded.comments[0].id;
    updates.length = 0;
    await updateComment('ser-2', commentId, { status: 'accepted' });
    expect(updates).toContainEqual({ recordKind: 'series', recordId: 'ser-2' });
  });

  it('mergeReviewFromSync does NOT emit (receive path — avoids an echo loop)', async () => {
    await mergeReviewFromSync('ser-3', {
      schemaVersion: 1,
      comments: [{ id: 'mrc-x', problem: 'remote note', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
    });
    expect(updates).toEqual([]);
  });
});
