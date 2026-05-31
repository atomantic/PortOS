import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockNoPeerSync, mockNoPeers } from '../../lib/mockPathsDataRoot.js';

const fileStore = new Map();
let stageRunnerSpy;

vi.mock('../../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

vi.mock('../instances.js', () => mockNoPeers());
vi.mock('../sharing/peerSync.js', () => mockNoPeerSync());

vi.mock('../../lib/stageRunner.js', () => ({
  runStagedLLM: vi.fn((...args) => stageRunnerSpy(...args)),
  extractJson: (raw) => JSON.parse(raw),
}));

const seriesSvc = await import('./series.js');
const issuesSvc = await import('./issues.js');
const review = await import('./manuscriptReview.js');
const fixer = await import('./manuscriptFix.js');

async function setupSeriesWithDraft(output = 'The hero walked in. She left.') {
  const s = await seriesSvc.createSeries({ name: 'Draft', logline: 'lg', premise: 'pr', issueCountTarget: 1 });
  const issue = await issuesSvc.createIssue({
    seriesId: s.id, number: 1, title: 'One', arcPosition: 1,
    stages: { prose: { output, status: 'ready' } },
  });
  return { s, issue };
}

const finding = (over = {}) => ({
  severity: 'high', category: 'arc-gap', issueNumber: 1,
  anchorQuote: 'She left.', problem: 'abrupt ending', suggestion: 'add a beat', ...over,
});

beforeEach(() => {
  fileStore.clear();
  uuidCounter = 0;
  stageRunnerSpy = undefined;
});

describe('manuscriptReview', () => {
  it('getReview returns an empty review when none exists', async () => {
    const { s } = await setupSeriesWithDraft();
    expect(await review.getReview(s.id)).toEqual({ schemaVersion: 1, comments: [] });
  });

  it('seedReviewFromFindings resolves issueId/stageId from the manuscript section', async () => {
    const { s, issue } = await setupSeriesWithDraft();
    const seeded = await review.seedReviewFromFindings(s.id, [finding()], { runId: 'r1' });
    expect(seeded.comments).toHaveLength(1);
    expect(seeded.comments[0]).toMatchObject({ issueNumber: 1, issueId: issue.id, stageId: 'prose', status: 'open', sourceRunId: 'r1' });
  });

  it('seedReviewFromFindings dedupes identical findings but preserves resolved ones', async () => {
    const { s } = await setupSeriesWithDraft();
    const first = await review.seedReviewFromFindings(s.id, [finding()]);
    // Dismiss it, then re-seed the same finding + a new one.
    await review.updateComment(s.id, first.comments[0].id, { status: 'dismissed' });
    const second = await review.seedReviewFromFindings(s.id, [finding(), finding({ problem: 'new gap', anchorQuote: 'walked in.' })]);
    // The dismissed one is kept (not re-opened as a dup), only the genuinely new finding is added.
    expect(second.comments).toHaveLength(2);
    expect(second.comments.find((c) => c.status === 'dismissed')).toBeTruthy();
    expect(second.comments.find((c) => c.problem === 'new gap')).toBeTruthy();
  });

  it('seedReviewFromFindings preserves an in-progress open comment (and its fix) on re-run', async () => {
    const { s } = await setupSeriesWithDraft();
    const first = await review.seedReviewFromFindings(s.id, [finding()]);
    // User generated a fix but hasn't accepted yet — must not be wiped by a re-run.
    await review.updateComment(s.id, first.comments[0].id, { fix: { find: 'She left.', replace: 'She left, slowly.' } });
    const second = await review.seedReviewFromFindings(s.id, [finding(), finding({ problem: 'new gap', anchorQuote: 'walked in.' })]);
    const original = second.comments.find((c) => c.problem === 'abrupt ending');
    expect(original).toBeTruthy();
    expect(original.status).toBe('open');
    expect(original.fix).toMatchObject({ replace: 'She left, slowly.' });
    expect(second.comments).toHaveLength(2); // original preserved + 1 new, no duplicate
  });

  it('updateComment flips status and attaches a fix, last-write-wins on updatedAt', async () => {
    const { s } = await setupSeriesWithDraft();
    const seeded = await review.seedReviewFromFindings(s.id, [finding()]);
    const id = seeded.comments[0].id;
    const withFix = await review.updateComment(s.id, id, { fix: { find: 'She left.', replace: 'She left, slowly.' } });
    expect(withFix.fix).toMatchObject({ find: 'She left.', replace: 'She left, slowly.' });
    await expect(review.updateComment(s.id, 'mrc-nope', { status: 'open' })).rejects.toMatchObject({ code: 'PIPELINE_REVIEW_NOT_FOUND' });
  });

  it('mergeReviewFromSync takes the newer comment per id', async () => {
    const { s } = await setupSeriesWithDraft();
    const seeded = await review.seedReviewFromFindings(s.id, [finding()]);
    const remote = {
      schemaVersion: 1,
      comments: [{ ...seeded.comments[0], status: 'accepted', updatedAt: '2999-01-01T00:00:00.000Z' }],
    };
    const merged = await review.mergeReviewFromSync(s.id, remote);
    expect(merged.comments[0].status).toBe('accepted');
  });
});

describe('manuscriptFix', () => {
  it('generateManuscriptFix persists an anchored fix and flags non-verbatim find as fuzzy', async () => {
    const { s } = await setupSeriesWithDraft();
    const seeded = await review.seedReviewFromFindings(s.id, [finding()]);
    const id = seeded.comments[0].id;

    stageRunnerSpy = vi.fn(async (template) => {
      expect(template).toBe('pipeline-manuscript-fix');
      return { content: { find: 'She left.', replace: 'She left, but paused at the door.' }, runId: 'rf' };
    });
    const ok = await fixer.generateManuscriptFix(s.id, { commentId: id });
    expect(ok.fix).toMatchObject({ find: 'She left.' });
    expect(ok.fix.fuzzy).toBeUndefined();
    expect(ok.comment.fix.replace).toContain('paused');

    stageRunnerSpy = vi.fn(async () => ({ content: { find: 'NOT IN TEXT', replace: 'whatever' }, runId: 'rf2' }));
    const fuzzy = await fixer.generateManuscriptFix(s.id, { commentId: id });
    expect(fuzzy.fix.fuzzy).toBe(true);
  });

  it('generateManuscriptFix rejects a fix with no find (unappliable by the accept path)', async () => {
    const { s } = await setupSeriesWithDraft();
    const seeded = await review.seedReviewFromFindings(s.id, [finding()]);
    stageRunnerSpy = vi.fn(async () => ({ content: { replace: 'only a replacement, no find' }, runId: 'rf3' }));
    await expect(
      fixer.generateManuscriptFix(s.id, { commentId: seeded.comments[0].id }),
    ).rejects.toMatchObject({ code: 'PIPELINE_MANUSCRIPT_FIX_VALIDATION' });
  });

  it('acceptManuscriptFix applies the find/replace to the stage output and marks the comment accepted', async () => {
    const { s, issue } = await setupSeriesWithDraft();
    const seeded = await review.seedReviewFromFindings(s.id, [finding()]);
    const id = seeded.comments[0].id;

    const result = await fixer.acceptManuscriptFix(s.id, { commentId: id, find: 'She left.', replace: 'She left, but paused.' });
    expect(result.comment.status).toBe('accepted');
    expect(result.section.content).toBe('The hero walked in. She left, but paused.');

    const after = await issuesSvc.getIssue(issue.id);
    expect(after.stages.prose.output).toBe('The hero walked in. She left, but paused.');
  });

  it('acceptManuscriptFix targets the occurrence nearest the anchorQuote when find is ambiguous', async () => {
    // "the door" appears twice; the comment anchors the SECOND one.
    const { s, issue } = await setupSeriesWithDraft('She opened the door. Later, she slammed the door shut.');
    const seeded = await review.seedReviewFromFindings(s.id, [finding({ anchorQuote: 'slammed the door shut', problem: 'weak verb' })]);
    const result = await fixer.acceptManuscriptFix(s.id, { commentId: seeded.comments[0].id, find: 'the door', replace: 'the oak door' });
    // The first "the door" is untouched; the one by the anchor is edited.
    expect(result.section.content).toBe('She opened the door. Later, she slammed the oak door shut.');
    const after = await issuesSvc.getIssue(issue.id);
    expect(after.stages.prose.output).toBe('She opened the door. Later, she slammed the oak door shut.');
  });

  it('acceptManuscriptFix throws when the anchor text is gone', async () => {
    const { s } = await setupSeriesWithDraft();
    const seeded = await review.seedReviewFromFindings(s.id, [finding()]);
    await expect(
      fixer.acceptManuscriptFix(s.id, { commentId: seeded.comments[0].id, find: 'GONE', replace: 'x' }),
    ).rejects.toMatchObject({ code: 'PIPELINE_MANUSCRIPT_FIX_VALIDATION' });
  });

  it('acceptManuscriptFix snapshots the pre-fix text even on an imported stage (no prior runId)', async () => {
    const { s, issue } = await setupSeriesWithDraft();
    const seeded = await review.seedReviewFromFindings(s.id, [finding()]);
    const result = await fixer.acceptManuscriptFix(s.id, { commentId: seeded.comments[0].id, find: 'She left.', replace: 'She left, but paused.' });
    // The original imported text is now revertible from history.
    expect(result.section.versions.length).toBe(1);
    const after = await issuesSvc.getIssue(issue.id);
    expect(after.stages.prose.runHistory[0].output).toBe('The hero walked in. She left.');
  });
});

describe('saveManuscriptSection (versioned free-text edit)', () => {
  it('writes the new output and snapshots the prior text for revert', async () => {
    const { s, issue } = await setupSeriesWithDraft('Original prose.');
    const out = await fixer.saveManuscriptSection(s.id, { issueId: issue.id, stageId: 'prose', output: 'Edited prose.' });
    expect(out.section.content).toBe('Edited prose.');
    expect(out.section.versions.length).toBe(1); // prior version retained

    const after = await issuesSvc.getIssue(issue.id);
    expect(after.stages.prose.output).toBe('Edited prose.');
    expect(after.stages.prose.runHistory[0].output).toBe('Original prose.');

    // Revert restores the original through the existing restore path.
    const runId = out.section.versions[0].runId;
    const { stage } = await issuesSvc.restoreStageFromHistory(issue.id, 'prose', runId);
    expect(stage.output).toBe('Original prose.');
  });

  it('rejects a non-manuscript stage', async () => {
    const { s, issue } = await setupSeriesWithDraft();
    await expect(
      fixer.saveManuscriptSection(s.id, { issueId: issue.id, stageId: 'idea', output: 'x' }),
    ).rejects.toMatchObject({ code: 'PIPELINE_MANUSCRIPT_FIX_VALIDATION' });
  });
});
