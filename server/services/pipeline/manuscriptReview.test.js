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
  // sanitizeComment imports these to classify a finding's suggestion. Mirror
  // the real (pure) implementations so the mock doesn't drop them.
  REPLACEMENT_STRATEGIES: new Set(['delta', 'full-page']),
  replacementStrategyForCategory: (category) => (category === 'comic-structure' ? 'full-page' : 'delta'),
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

  it('persists replacementStrategy (explicit value, derived from category, and legacy fallback)', async () => {
    const seeded = await seedReviewFromFindings('ser-4', [
      { category: 'comic-structure', problem: 'page is prose', suggestion: 'Panel 1 …', anchorQuote: 'PAGE 5' },
      { category: 'missing-content', problem: 'no climax', suggestion: 'add one', anchorQuote: 'the end' },
    ]);
    const byProblem = Object.fromEntries(seeded.comments.map((c) => [c.problem, c]));
    expect(byProblem['page is prose'].replacementStrategy).toBe('full-page');
    expect(byProblem['no climax'].replacementStrategy).toBe('delta');

    // A legacy/older-peer comment with no strategy field round-trips through
    // sanitize with the field derived from its category.
    const merged = await mergeReviewFromSync('ser-5', {
      schemaVersion: 1,
      comments: [
        { id: 'mrc-cs', category: 'comic-structure', problem: 'legacy panels', status: 'open', updatedAt: '2026-06-02T00:00:00Z' },
        { id: 'mrc-mc', category: 'missing-content', problem: 'legacy beat', status: 'open', updatedAt: '2026-06-02T00:00:00Z' },
      ],
    });
    const mergedById = Object.fromEntries(merged.comments.map((c) => [c.id, c]));
    expect(mergedById['mrc-cs'].replacementStrategy).toBe('full-page');
    expect(mergedById['mrc-mc'].replacementStrategy).toBe('delta');
  });
});

describe('manuscriptReview — re-run merge vs fresh reconcile', () => {
  beforeEach(() => { fileStore.clear(); });

  const byStatus = (review, s) =>
    review.comments.filter((c) => c.status === s).map((c) => c.problem).sort();

  // Seed four findings, then flip one accepted and one dismissed, leaving two
  // open ('still-found' + 'gone-open') — the realistic state when a user re-runs
  // the editorial pass.
  async function seedDecidedState(seriesId) {
    const seeded = await seedReviewFromFindings(seriesId, [
      { problem: 'kept-dismissed', anchorQuote: 'a' },
      { problem: 'was-accepted', anchorQuote: 'b' },
      { problem: 'still-found', anchorQuote: 'c' },
      { problem: 'gone-open', anchorQuote: 'd' },
    ]);
    const byProblem = Object.fromEntries(seeded.comments.map((c) => [c.problem, c]));
    await updateComment(seriesId, byProblem['kept-dismissed'].id, { status: 'dismissed' });
    await updateComment(seriesId, byProblem['was-accepted'].id, { status: 'accepted' });
    return byProblem;
  }

  it('merge (default) leaves every prior comment as-is and appends new findings', async () => {
    await seedDecidedState('ser-merge');
    // 'gone-open' is NOT in this run, but merge must keep it open regardless.
    const next = await seedReviewFromFindings('ser-merge', [
      { problem: 'still-found', anchorQuote: 'c' },
      { problem: 'brand new', anchorQuote: 'e' },
    ]);
    expect(byStatus(next, 'open')).toEqual(['brand new', 'gone-open', 'still-found']);
    expect(byStatus(next, 'accepted')).toEqual(['was-accepted']);
    expect(byStatus(next, 'dismissed')).toEqual(['kept-dismissed']);
  });

  it('fresh reconciles: keeps still-found opens, auto-dismisses gone opens, appends new', async () => {
    const before = await seedDecidedState('ser-fresh');
    const next = await seedReviewFromFindings(
      'ser-fresh',
      [
        { problem: 'still-found', anchorQuote: 'c' },
        { problem: 'brand new', anchorQuote: 'e' },
      ],
      { mode: 'fresh' },
    );
    // still-found stays open (same id — a flip-free carry-forward), gone-open is
    // auto-dismissed, brand new is appended, accepted/dismissed untouched.
    expect(byStatus(next, 'open')).toEqual(['brand new', 'still-found']);
    expect(byStatus(next, 'accepted')).toEqual(['was-accepted']);
    expect(byStatus(next, 'dismissed')).toEqual(['gone-open', 'kept-dismissed']);
    const stillFound = next.comments.find((c) => c.problem === 'still-found');
    expect(stillFound.id).toBe(before['still-found'].id);
    expect(stillFound.status).toBe('open');
    // Nothing is deleted — every prior comment is still present (synced flips,
    // not omissions), so a peer can't resurrect a cleared note.
    expect(next.comments).toHaveLength(5);
  });

  it('fresh does NOT resurrect a finding the user dismissed (deduped against survivors)', async () => {
    await seedDecidedState('ser-fresh-dedup');
    // The new pass re-reports the same finding the user already dismissed.
    const next = await seedReviewFromFindings(
      'ser-fresh-dedup',
      [{ problem: 'kept-dismissed', anchorQuote: 'a' }],
      { mode: 'fresh' },
    );
    const kept = next.comments.filter((c) => c.problem === 'kept-dismissed');
    expect(kept).toHaveLength(1);
    expect(kept[0].status).toBe('dismissed');
  });
});
