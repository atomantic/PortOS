import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// In-memory file store so reads/writes round-trip without touching disk.
const fileStore = new Map();
vi.mock('../../lib/fileUtils.js', () => ({
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

// seriesStore().recordDir(id) → a stable per-series path key. `listSeries`
// derives the seeded series ids straight from the in-memory file store so
// locateComment's cross-series scan stays consistent with whatever was seeded.
vi.mock('./series.js', () => ({
  seriesStore: () => ({ recordDir: (id) => `/mock/series/${id}` }),
  listSeries: async () => {
    const ids = [];
    for (const key of fileStore.keys()) {
      const id = /^\/mock\/series\/([^/]+)\//.exec(key)?.[1];
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids.map((id) => ({ id }));
  },
}));

// No manuscript sections needed for most tests (seed resolves issueId/stageId
// from them, but we don't assert on those here). The with-edits fix-seeding test
// overrides this to return a section so the anchor can resolve.
vi.mock('./arcPlanner.js', () => ({
  collectManuscriptSections: vi.fn(async () => []),
  // sanitizeComment imports these to classify a finding's suggestion. Mirror
  // the real (pure) implementations so the mock doesn't drop them.
  REPLACEMENT_STRATEGIES: new Set(['delta', 'full-page']),
  replacementStrategyForCategory: (category) => (category === 'comic-structure' ? 'full-page' : 'delta'),
}));

import { recordEvents } from '../sharing/recordEvents.js';
import { collectManuscriptSections } from './arcPlanner.js';
import { seedReviewFromFindings, updateComment, mergeReviewFromSync, getReview, locateComment, DISMISS_REASONS } from './manuscriptReview.js';

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

  it('mergeReviewFromSync is strict-LWW: newer remote wins, equal-clock echo is a no-op', async () => {
    // Local holds a comment the user has acted on (status 'accepted').
    await mergeReviewFromSync('ser-lww', {
      schemaVersion: 1,
      comments: [{ id: 'c1', problem: 'note', status: 'accepted', updatedAt: '2026-06-02T00:00:00Z' }],
    });

    // Equal-clock echo from a peer (same updatedAt) carrying a different status
    // must NOT overwrite the local copy — otherwise a full-snapshot sync cycle
    // re-adopts and re-writes it forever (write amplification / non-convergence).
    let merged = await mergeReviewFromSync('ser-lww', {
      schemaVersion: 1,
      comments: [{ id: 'c1', problem: 'note', status: 'open', updatedAt: '2026-06-02T00:00:00Z' }],
    });
    expect(merged.comments.find((c) => c.id === 'c1').status).toBe('accepted');

    // A strictly-newer remote DOES win.
    merged = await mergeReviewFromSync('ser-lww', {
      schemaVersion: 1,
      comments: [{ id: 'c1', problem: 'note', status: 'dismissed', updatedAt: '2026-06-03T00:00:00Z' }],
    });
    expect(merged.comments.find((c) => c.id === 'c1').status).toBe('dismissed');
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

  it('fresh scopes auto-dismissal to its own checkId — leaves other checks open', async () => {
    // A registry check seeds an open finding (its own checkId).
    await seedReviewFromFindings(
      'ser-fresh-scope',
      [{ problem: 'info dump', anchorQuote: 'as you know', checkId: 'prose.info-dumping' }],
      { mode: 'merge' },
    );
    // A completeness pass (no checkId) re-runs in fresh mode and finds something
    // else entirely. It must NOT dismiss the registry check's open finding.
    const next = await seedReviewFromFindings(
      'ser-fresh-scope',
      [{ problem: 'Act II sags', anchorQuote: 'the road' }],
      { mode: 'fresh' },
    );
    const infoDump = next.comments.find((c) => c.problem === 'info dump');
    expect(infoDump.status).toBe('open');
    expect(infoDump.checkId).toBe('prose.info-dumping');
    expect(next.comments.find((c) => c.problem === 'Act II sags').status).toBe('open');
  });
});

describe('manuscriptReview — with-edits fix seeding', () => {
  beforeEach(() => {
    fileStore.clear();
    // A section whose content contains the verbatim anchor so the fix resolves.
    collectManuscriptSections.mockResolvedValue([
      { issueId: 'iss-1', stageId: 'prose', number: 1, title: 'One', content: 'The hero walked in. She left.' },
    ]);
  });
  afterEach(() => { collectManuscriptSections.mockResolvedValue([]); });

  it('attaches a fix built from { find: anchorQuote, replace } when the finding carries a replace', async () => {
    const seeded = await seedReviewFromFindings('ser-edits', [
      { problem: 'abrupt ending', anchorQuote: 'She left.', replace: 'She left, but paused.', issueNumber: 1 },
    ]);
    const c = seeded.comments[0];
    expect(c.fix).toBeTruthy();
    expect(c.fix.find).toBe('She left.');
    expect(c.fix.replace).toBe('She left, but paused.');
    expect(c.fix.edits).toHaveLength(1);
    expect(c.fix.edits[0]).toMatchObject({ issueId: 'iss-1', stageId: 'prose', issueNumber: 1, find: 'She left.', replace: 'She left, but paused.' });
    // `replace` is consumed into the fix, not persisted as a stray comment field.
    expect(c.replace).toBeUndefined();
  });

  it('still attaches a fix when the anchor differs only in whitespace (tolerant match)', async () => {
    const seeded = await seedReviewFromFindings('ser-edits-fuzzy', [
      { problem: 'gap', anchorQuote: 'She   left.', replace: 'She left, but paused.', issueNumber: 1 },
    ]);
    // The exact span "She   left." is absent, but the whitespace-tolerant locate
    // matches "She left." — accept would succeed, so the fix attaches (not gated
    // out as unappliable).
    const c = seeded.comments[0];
    expect(c.fix).toBeTruthy();
    expect(c.fix.find).toBe('She   left.');
  });

  it('leaves fix null when the finding has no replace (advice-only / findings pass)', async () => {
    const seeded = await seedReviewFromFindings('ser-no-edits', [
      { problem: 'just advice', anchorQuote: 'She left.', issueNumber: 1 },
    ]);
    expect(seeded.comments[0].fix).toBeNull();
  });

  it('leaves fix null when the anchor cannot be located in any section', async () => {
    const seeded = await seedReviewFromFindings('ser-no-anchor', [
      { problem: 'unanchorable', anchorQuote: 'text that does not appear', replace: 'rewrite', issueNumber: 1 },
    ]);
    expect(seeded.comments[0].fix).toBeNull();
  });

  it('does NOT pre-seed a fix for a full-page (comic-structure) finding — anchor is only the page opening', async () => {
    // The anchor ("The hero") is present, but for full-page the replace is the
    // whole rewritten page; splicing it over just the anchor would corrupt the
    // page, so the seed defers to the manual full-page fix path (fix stays null).
    const seeded = await seedReviewFromFindings('ser-fullpage', [
      {
        category: 'comic-structure', replacementStrategy: 'full-page',
        problem: 'page is prose', anchorQuote: 'The hero',
        replace: 'Panel 1\nDescription: …\nPanel 2\nDescription: …', issueNumber: 1,
      },
    ]);
    expect(seeded.comments[0].fix).toBeNull();
  });

  it('backfills a fix onto an existing open comment that lacked one when a with-edits re-run re-surfaces it', async () => {
    // First pass: findings-only (no replace) → comment lands advice-only.
    const first = await seedReviewFromFindings('ser-backfill', [
      { problem: 'abrupt ending', anchorQuote: 'She left.', issueNumber: 1 },
    ]);
    expect(first.comments[0].fix).toBeNull();
    const id = first.comments[0].id;

    // Second pass: same finding (same key) now carries a replace. It's deduped
    // out of the append path, but the carried-forward open comment is backfilled.
    const second = await seedReviewFromFindings('ser-backfill', [
      { problem: 'abrupt ending', anchorQuote: 'She left.', replace: 'She left, but paused.', issueNumber: 1 },
    ]);
    expect(second.comments).toHaveLength(1);
    const c = second.comments[0];
    expect(c.id).toBe(id); // same comment, not a duplicate
    expect(c.fix).toBeTruthy();
    expect(c.fix.replace).toBe('She left, but paused.');
  });

  it('does NOT overwrite an existing fix on backfill (only fills comments that lack one)', async () => {
    const first = await seedReviewFromFindings('ser-backfill-keep', [
      { problem: 'abrupt ending', anchorQuote: 'She left.', replace: 'She left, but paused.', issueNumber: 1 },
    ]);
    const original = first.comments[0].fix.replace;
    const second = await seedReviewFromFindings('ser-backfill-keep', [
      { problem: 'abrupt ending', anchorQuote: 'She left.', replace: 'A DIFFERENT rewrite.', issueNumber: 1 },
    ]);
    expect(second.comments[0].fix.replace).toBe(original); // untouched
  });
});

describe('manuscriptReview — sourceContentHash staleness fingerprint (#1345)', () => {
  beforeEach(() => { fileStore.clear(); });

  it('preserves a stamped sourceContentHash through seed + read (survives sanitize/sync round-trip)', async () => {
    const seeded = await seedReviewFromFindings('ser-hash', [
      { problem: 'naming clash', anchorQuote: 'Alina', checkId: 'naming.x', sourceContentHash: 'hash-v1' },
    ]);
    expect(seeded.comments[0].sourceContentHash).toBe('hash-v1');
    // Read back through sanitizeComment (the same shaper the sync importer uses).
    const review = await getReview('ser-hash');
    expect(review.comments[0].sourceContentHash).toBe('hash-v1');
  });

  it('defaults legacy findings with no hash to null', async () => {
    const seeded = await seedReviewFromFindings('ser-legacy', [
      { problem: 'no hash here', anchorQuote: 'q', checkId: 'naming.x' },
    ]);
    expect(seeded.comments[0].sourceContentHash).toBeNull();
  });

  it('refreshes the hash on a re-surfaced open finding when content changed (clears stale after re-run)', async () => {
    await seedReviewFromFindings('ser-refresh', [
      { problem: 'naming clash', anchorQuote: 'Alina', checkId: 'naming.x', sourceContentHash: 'hash-v1' },
    ]);
    // Same finding (same key) re-surfaces from a run against edited content → new hash.
    const second = await seedReviewFromFindings('ser-refresh', [
      { problem: 'naming clash', anchorQuote: 'Alina', checkId: 'naming.x', sourceContentHash: 'hash-v2' },
    ]);
    expect(second.comments).toHaveLength(1); // deduped, not appended
    expect(second.comments[0].sourceContentHash).toBe('hash-v2'); // refreshed
  });

  it('does NOT churn updatedAt when the re-surfaced finding has the same hash', async () => {
    const first = await seedReviewFromFindings('ser-nochurn', [
      { problem: 'naming clash', anchorQuote: 'Alina', checkId: 'naming.x', sourceContentHash: 'hash-v1' },
    ]);
    const stamp = first.comments[0].updatedAt;
    const second = await seedReviewFromFindings('ser-nochurn', [
      { problem: 'naming clash', anchorQuote: 'Alina', checkId: 'naming.x', sourceContentHash: 'hash-v1' },
    ]);
    expect(second.comments[0].updatedAt).toBe(stamp); // unchanged — no rewrite
  });
});

describe('manuscriptReview — authoritative severity override re-grade (#1596)', () => {
  beforeEach(() => { fileStore.clear(); });
  const CHECK = 'prose.adverb-density';
  const finding = (severity) => ({ problem: 'adverb density', anchorQuote: 'quickly', checkId: CHECK, severity });
  const ran = { regradeCheckIds: [CHECK] }; // this check ran this pass

  it('re-grades a re-surfaced open comment to the pinned level via severityOverrides', async () => {
    await seedReviewFromFindings('ser-sev', [finding('low')], ran);
    // Same finding key (severity is NOT part of the key) re-surfaces while the
    // check is now pinned to `high` — the candidate carries the effective level.
    const second = await seedReviewFromFindings('ser-sev', [finding('high')], {
      ...ran, severityOverrides: { [CHECK]: 'high' },
    });
    expect(second.comments).toHaveLength(1); // deduped, not appended
    expect(second.comments[0].severity).toBe('high'); // re-graded to the pinned level
  });

  it('re-grades a NON-resurfaced open comment of a pinned check (merge mode)', async () => {
    await seedReviewFromFindings('ser-sev-merge', [finding('low')], ran);
    // A later merge-mode run finds nothing for this check (LLM variance), but the
    // check ran and is pinned to `high` — the lingering open must still re-grade.
    const second = await seedReviewFromFindings('ser-sev-merge', [], {
      ...ran, mode: 'merge', severityOverrides: { [CHECK]: 'high' },
    });
    expect(second.comments).toHaveLength(1); // not dismissed in merge mode
    expect(second.comments[0].severity).toBe('high');
  });

  it('re-grades a re-surfaced open comment back to native when a pin is CLEARED', async () => {
    await seedReviewFromFindings('ser-sev-clear', [finding('high')], {
      ...ran, severityOverrides: { [CHECK]: 'high' },
    });
    // Pin cleared (no override map) and the finding re-surfaces at its native
    // 'low' level — the comment must drop back to 'low', not stay stuck at 'high'.
    const second = await seedReviewFromFindings('ser-sev-clear', [finding('low')], ran);
    expect(second.comments).toHaveLength(1);
    expect(second.comments[0].severity).toBe('low');
  });

  it('re-grades a NON-resurfaced open comment back to native when a pin is cleared', async () => {
    // Mirror the runner's stamp for a pinned finding: effective high, native low.
    await seedReviewFromFindings('ser-sev-clearmerge', [
      { problem: 'adverb density', anchorQuote: 'quickly', checkId: CHECK, severity: 'high', nativeSeverity: 'low' },
    ], { ...ran, severityOverrides: { [CHECK]: 'high' } });
    // Pin cleared, and a later merge run (this check ran, found nothing) — the
    // lingering open must still drop from the old pin back to its stored native.
    const second = await seedReviewFromFindings('ser-sev-clearmerge', [], { ...ran, mode: 'merge' });
    expect(second.comments).toHaveLength(1); // preserved in merge mode
    expect(second.comments[0].severity).toBe('low'); // restored from stored nativeSeverity
  });

  it('does NOT re-grade a pinned comment for a check excluded from a targeted subset run', async () => {
    // A comment pinned high (native low) for adverb-density.
    await seedReviewFromFindings('ser-sev-subset', [
      { problem: 'adverb density', anchorQuote: 'quickly', checkId: CHECK, severity: 'high', nativeSeverity: 'low' },
    ], { ...ran, severityOverrides: { [CHECK]: 'high' } });
    // A later SUBSET run targets a DIFFERENT check only: adverb-density neither
    // re-surfaces nor appears in severityOverrides/regradeCheckIds. Its pinned
    // comment must be left alone (NOT silently cleared back to native).
    const second = await seedReviewFromFindings('ser-sev-subset', [
      { problem: 'other', anchorQuote: 'x', checkId: 'prose.other-check', severity: 'medium', nativeSeverity: 'medium' },
    ], { mode: 'merge', severityOverrides: {}, regradeCheckIds: ['prose.other-check'] });
    const pinned = second.comments.find((c) => c.checkId === CHECK);
    expect(pinned.severity).toBe('high'); // pin preserved — not cleared to native
  });

  it('does NOT churn a never-pinned non-resurfaced comment (native == severity)', async () => {
    const first = await seedReviewFromFindings('ser-sev-stable', [finding('high')], ran);
    const stamp = first.comments[0].updatedAt;
    expect(first.comments[0].nativeSeverity).toBe('high'); // defaults to severity
    const second = await seedReviewFromFindings('ser-sev-stable', [], { ...ran, mode: 'merge' });
    expect(second.comments[0].severity).toBe('high'); // unchanged
    expect(second.comments[0].updatedAt).toBe(stamp); // no rewrite
  });

  it('does NOT churn updatedAt when the pinned level already matches', async () => {
    const first = await seedReviewFromFindings('ser-sev-nochurn', [finding('high')], ran);
    const stamp = first.comments[0].updatedAt;
    const second = await seedReviewFromFindings('ser-sev-nochurn', [finding('high')], {
      ...ran, severityOverrides: { [CHECK]: 'high' },
    });
    expect(second.comments[0].updatedAt).toBe(stamp); // unchanged — no rewrite
  });
});

describe('manuscriptReview — false-positive dismissal reason (#1605)', () => {
  beforeEach(() => fileStore.clear());

  it('exposes false-positive as the canonical dismissal reason', () => {
    expect(DISMISS_REASONS).toContain('false-positive');
  });

  it('seeded findings carry a null dismissReason by default', async () => {
    const seeded = await seedReviewFromFindings('fp-seed', [{ problem: 'P', anchorQuote: 'q' }]);
    expect(seeded.comments[0].dismissReason).toBeNull();
  });

  it('updateComment records a false-positive dismissal', async () => {
    const seeded = await seedReviewFromFindings('fp-set', [{ problem: 'P', anchorQuote: 'q' }]);
    const id = seeded.comments[0].id;
    const updated = await updateComment('fp-set', id, { status: 'dismissed', dismissReason: 'false-positive' });
    expect(updated.status).toBe('dismissed');
    expect(updated.dismissReason).toBe('false-positive');
    // Survives a read-back through sanitize (the same shaper sync uses).
    const persisted = (await getReview('fp-set')).comments[0];
    expect(persisted.dismissReason).toBe('false-positive');
  });

  it('clears the reason when the finding is re-opened', async () => {
    const seeded = await seedReviewFromFindings('fp-reopen', [{ problem: 'P', anchorQuote: 'q' }]);
    const id = seeded.comments[0].id;
    await updateComment('fp-reopen', id, { status: 'dismissed', dismissReason: 'false-positive' });
    const reopened = await updateComment('fp-reopen', id, { status: 'open' });
    // sanitize drops a reason that no longer applies to the (non-dismissed) status.
    expect(reopened.dismissReason).toBeNull();
  });

  it('clears the reason on an explicit plain dismiss (dismissReason: null)', async () => {
    const seeded = await seedReviewFromFindings('fp-plain', [{ problem: 'P', anchorQuote: 'q' }]);
    const id = seeded.comments[0].id;
    await updateComment('fp-plain', id, { status: 'dismissed', dismissReason: 'false-positive' });
    const plain = await updateComment('fp-plain', id, { status: 'dismissed', dismissReason: null });
    expect(plain.status).toBe('dismissed');
    expect(plain.dismissReason).toBeNull();
  });

  it('rejects an unknown reason (sanitizes to null)', async () => {
    const seeded = await seedReviewFromFindings('fp-bad', [{ problem: 'P', anchorQuote: 'q' }]);
    const id = seeded.comments[0].id;
    const updated = await updateComment('fp-bad', id, { status: 'dismissed', dismissReason: 'bogus' });
    expect(updated.dismissReason).toBeNull();
  });

  it('survives a sync round-trip and never resurrects a stale reason on a non-dismissed peer record', async () => {
    const merged = await mergeReviewFromSync('fp-sync', {
      comments: [
        { id: 'fp1', problem: 'real fp', status: 'dismissed', dismissReason: 'false-positive', updatedAt: '2026-06-25T00:00:00Z' },
        { id: 'fp2', problem: 'open with stray reason', status: 'open', dismissReason: 'false-positive', updatedAt: '2026-06-25T00:00:00Z' },
      ],
    });
    const byId = Object.fromEntries(merged.comments.map((c) => [c.id, c]));
    expect(byId.fp1.dismissReason).toBe('false-positive');
    expect(byId.fp2.dismissReason).toBeNull(); // not dismissed → reason dropped
  });
});

describe('manuscriptReview — locateComment (cross-series deep-link resolver, #1608)', () => {
  beforeEach(() => { fileStore.clear(); });

  it('resolves the owning series + comment for a known id', async () => {
    await seedReviewFromFindings('loc-a', [{ problem: 'Act I drags', anchorQuote: 'q1' }]);
    const seededB = await seedReviewFromFindings('loc-b', [{ problem: 'POV slips', anchorQuote: 'q2' }]);
    const targetId = seededB.comments[0].id;

    const located = await locateComment(targetId);
    expect(located).toMatchObject({ seriesId: 'loc-b' });
    expect(located.comment.id).toBe(targetId);
    expect(located.comment.problem).toBe('POV slips');
  });

  it('returns null when no series review owns the id', async () => {
    await seedReviewFromFindings('loc-a', [{ problem: 'P', anchorQuote: 'q' }]);
    expect(await locateComment('comment-does-not-exist')).toBeNull();
  });

  it('returns null for a blank/non-string id without scanning', async () => {
    expect(await locateComment('')).toBeNull();
    expect(await locateComment(null)).toBeNull();
    expect(await locateComment(undefined)).toBeNull();
  });
});

describe('manuscriptReview — accepted-fix undo snapshot (#1609)', () => {
  beforeEach(() => { fileStore.clear(); });

  const snapshot = () => ({
    acceptedAt: '2026-06-25T00:00:00.000Z',
    sections: [{ issueId: 'i1', stageId: 'prose', priorText: 'Before.', appliedHash: 'a'.repeat(64) }],
  });

  it('persists the snapshot while accepted and round-trips it through getReview', async () => {
    const seeded = await seedReviewFromFindings('ser-1', [{ problem: 'P', anchorQuote: 'q' }]);
    const id = seeded.comments[0].id;
    const updated = await updateComment('ser-1', id, { status: 'accepted', acceptedSnapshot: snapshot() });
    expect(updated.status).toBe('accepted');
    expect(updated.acceptedSnapshot.sections[0]).toMatchObject({ issueId: 'i1', stageId: 'prose', priorText: 'Before.' });
    const review = await getReview('ser-1');
    expect(review.comments[0].acceptedSnapshot.sections[0].priorText).toBe('Before.');
  });

  it('drops the snapshot when the comment is re-opened (status gate)', async () => {
    const seeded = await seedReviewFromFindings('ser-1', [{ problem: 'P', anchorQuote: 'q' }]);
    const id = seeded.comments[0].id;
    await updateComment('ser-1', id, { status: 'accepted', acceptedSnapshot: snapshot() });
    const reopened = await updateComment('ser-1', id, { status: 'open' });
    expect(reopened.status).toBe('open');
    expect(reopened.acceptedSnapshot).toBeNull();
  });

  it('drops a malformed snapshot (missing priorText) and an open-comment snapshot', async () => {
    const seeded = await seedReviewFromFindings('ser-1', [{ problem: 'P', anchorQuote: 'q' }]);
    const id = seeded.comments[0].id;
    // Snapshot on an open comment never persists.
    const stillOpen = await updateComment('ser-1', id, { acceptedSnapshot: snapshot() });
    expect(stillOpen.acceptedSnapshot).toBeNull();
    // Accepted but malformed (no priorText) sanitizes to null.
    const bad = await updateComment('ser-1', id, {
      status: 'accepted',
      acceptedSnapshot: { sections: [{ issueId: 'i1', stageId: 'prose' }] },
    });
    expect(bad.acceptedSnapshot).toBeNull();
  });
});
