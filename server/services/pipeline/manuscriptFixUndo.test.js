import { describe, it, expect, beforeEach, vi } from 'vitest';

// In-memory issue + review stores so acceptManuscriptFix/undoManuscriptFix
// round-trip through the same persistence shape the real services use, without
// touching disk. Names are `mock`-prefixed so vitest's hoisted vi.mock factories
// may reference them (#1609).
const mockIssues = new Map();
const mockComments = new Map();

vi.mock('./series.js', () => ({
  getSeries: vi.fn(async () => ({ id: 'ser-1', name: 'S' })),
  MANUSCRIPT_TYPES: ['prose', 'comicScript', 'teleplay'],
}));

vi.mock('./arcPlanner.js', () => ({
  // resolveTargets resolves a comment's section here.
  collectManuscriptSections: vi.fn(async () => (
    [...mockIssues.values()].map((iss) => ({
      issueId: iss.id,
      stageId: 'prose',
      number: iss.number,
      title: iss.title || '',
      content: iss.stages.prose?.output || '',
    }))
  )),
  stageVersionsOf: () => [],
  sectionsCorpus: (sections) => sections.map((s) => s.content || '').join('\n'),
  manuscriptSectionHeader: (s) => `Issue ${s.number}`,
}));

vi.mock('./issues.js', () => ({
  getIssue: vi.fn(async (id) => mockIssues.get(id) || null),
  updateStageWithLatest: vi.fn(),
  // Mirror the real serialized write: call each computeFn against the freshest
  // stage, persist the merged patch, return [{ issue, stage }] in update order.
  updateStagesWithLatest: vi.fn(async (_seriesId, updates) => updates.map((u) => {
    const issue = mockIssues.get(u.issueId);
    const cur = issue.stages[u.stageId];
    const patch = u.computeFn(cur);
    const stage = { ...cur, ...patch };
    issue.stages[u.stageId] = stage;
    return { issue, stage };
  })),
}));

vi.mock('./manuscriptReview.js', () => ({
  getComment: vi.fn(async (_seriesId, id) => mockComments.get(id) || null),
  updateComment: vi.fn(async (_seriesId, id, patch) => {
    const cur = mockComments.get(id);
    const next = { ...cur, ...patch };
    // Mimic the real sanitizer's status-gating of the undo snapshot so the test
    // exercises the same drop-on-reopen contract.
    if (next.status !== 'accepted') next.acceptedSnapshot = null;
    mockComments.set(id, next);
    return next;
  }),
}));

import { acceptManuscriptFix, undoManuscriptFix } from './manuscriptFix.js';

function seed({ content = 'Hello old world.' } = {}) {
  mockIssues.clear();
  mockComments.clear();
  mockIssues.set('i1', { id: 'i1', number: 1, title: 'One', stages: { prose: { output: content, status: 'ready' } } });
  mockComments.set('mrc-1', {
    id: 'mrc-1', issueId: 'i1', stageId: 'prose', issueNumber: 1,
    anchorQuote: 'old', problem: 'wording', status: 'open',
    fix: { find: 'old', replace: 'new', edits: [{ issueId: 'i1', stageId: 'prose', issueNumber: 1, find: 'old', replace: 'new' }] },
  });
}

describe('acceptManuscriptFix — captures an undo snapshot (#1609)', () => {
  beforeEach(seed);

  it('records the pre-edit text + applied hash, then undo restores it and re-opens', async () => {
    const accepted = await acceptManuscriptFix('ser-1', {
      commentId: 'mrc-1',
      edits: [{ issueId: 'i1', stageId: 'prose', issueNumber: 1, find: 'old', replace: 'new' }],
    });
    // The edit applied.
    expect(mockIssues.get('i1').stages.prose.output).toBe('Hello new world.');
    expect(accepted.comment.status).toBe('accepted');
    // The snapshot captured the section's pre-edit text.
    const snap = accepted.comment.acceptedSnapshot;
    expect(snap.sections).toEqual([
      expect.objectContaining({ issueId: 'i1', stageId: 'prose', priorText: 'Hello old world.' }),
    ]);
    expect(snap.sections[0].appliedHash).toMatch(/^[0-9a-f]{64}$/);

    // Undo restores the pre-edit text and re-opens the finding.
    const undone = await undoManuscriptFix('ser-1', { commentId: 'mrc-1' });
    expect(mockIssues.get('i1').stages.prose.output).toBe('Hello old world.');
    expect(undone.comment.status).toBe('open');
    expect(undone.comment.acceptedSnapshot).toBeNull();
    expect(undone.sections[0].content).toBe('Hello old world.');
  });

  it('refuses to undo when the section changed since accept (no clobber)', async () => {
    await acceptManuscriptFix('ser-1', {
      commentId: 'mrc-1',
      edits: [{ issueId: 'i1', stageId: 'prose', issueNumber: 1, find: 'old', replace: 'new' }],
    });
    // The user keeps editing the section after accepting.
    mockIssues.get('i1').stages.prose.output = 'Hello new world. Plus more.';
    await expect(undoManuscriptFix('ser-1', { commentId: 'mrc-1' }))
      .rejects.toThrow(/changed since this fix was accepted/i);
    // The later edit is preserved (no restore happened).
    expect(mockIssues.get('i1').stages.prose.output).toBe('Hello new world. Plus more.');
  });

  it('throws when the comment has no accepted snapshot to undo', async () => {
    await expect(undoManuscriptFix('ser-1', { commentId: 'mrc-1' }))
      .rejects.toThrow(/no accepted edit to undo/i);
  });
});
