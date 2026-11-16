import { describe, it, expect } from 'vitest';
import {
  isProposalDuplicate,
  isIssueWithinDedupWindow,
  cosineSimilarity,
  findSemanticDuplicate,
  issueEmbedSeed,
} from './dedup.js';
import {
  CLOSED_SUPPRESSION_MS,
} from './constants.js';

describe('semantic dedup — pure helpers', () => {
  const NOW = Date.parse('2026-07-07T00:00:00Z');

  describe('isIssueWithinDedupWindow', () => {
    it('open issues are always in-window', () => {
      expect(isIssueWithinDedupWindow({ state: 'open' }, NOW)).toBe(true);
    });
    it('recently-closed issues are in-window; long-closed are not', () => {
      const recent = new Date(NOW - 5 * 24 * 60 * 60 * 1000).toISOString();
      const old = new Date(NOW - (CLOSED_SUPPRESSION_MS + 1000)).toISOString();
      expect(isIssueWithinDedupWindow({ state: 'closed', closedAt: recent }, NOW)).toBe(true);
      expect(isIssueWithinDedupWindow({ state: 'closed', closedAt: old }, NOW)).toBe(false);
    });
    it('closed with missing/unparseable close time stays permanently in-window (#2620)', () => {
      // Closed-without-closedAt (a checked `- [x]` PLAN item, or a tracker row
      // missing its close time) is completed work — it must stay suppressed,
      // not become re-proposable.
      expect(isIssueWithinDedupWindow({ state: 'closed' }, NOW)).toBe(true);
      expect(isIssueWithinDedupWindow({ state: 'closed', closedAt: 'not-a-date' }, NOW)).toBe(true);
    });
    it('agrees with isProposalDuplicate on the window boundary', () => {
      const old = new Date(NOW - (CLOSED_SUPPRESSION_MS + 1000)).toISOString();
      const existing = [{ slug: 'add-x', state: 'closed', closedAt: old }];
      expect(isProposalDuplicate({ slug: 'add-x', existingIssues: existing, now: NOW })).toBe(false);
      const recent = new Date(NOW - 1000).toISOString();
      const existing2 = [{ slug: 'add-x', state: 'closed', closedAt: recent }];
      expect(isProposalDuplicate({ slug: 'add-x', existingIssues: existing2, now: NOW })).toBe(true);
    });
  });

  describe('cosineSimilarity', () => {
    it('is 1 for identical vectors and 0 for orthogonal', () => {
      expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 6);
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
    });
    it('returns 0 (not NaN) for shape mismatch, empty, or zero-magnitude vectors', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
      expect(cosineSimilarity([], [])).toBe(0);
      expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
      expect(cosineSimilarity('x', [1])).toBe(0);
    });
  });

  describe('issueEmbedSeed', () => {
    it('joins trimmed title + body and caps length', () => {
      expect(issueEmbedSeed({ title: ' T ', body: ' B ' })).toBe('T\n\nB');
      expect(issueEmbedSeed({ title: '', body: 'only body' })).toBe('only body');
      expect(issueEmbedSeed({}).length).toBe(0);
      expect(issueEmbedSeed({ title: 'x'.repeat(5000) }).length).toBe(2000);
    });
  });

  describe('findSemanticDuplicate', () => {
    it('returns the highest-scoring candidate above threshold', () => {
      const p = [1, 0, 0];
      const candidates = [
        { slug: 'low', embedding: [0, 1, 0] },      // orthogonal → 0
        { slug: 'high', number: 9, embedding: [1, 0, 0] }, // identical → 1
      ];
      const match = findSemanticDuplicate({ proposalEmbedding: p, candidates, threshold: 0.9 });
      expect(match.slug).toBe('high');
      expect(match.number).toBe(9);
      expect(match.score).toBeCloseTo(1, 6);
    });
    it('returns null when nothing meets threshold, or the proposal embedding is unusable', () => {
      expect(findSemanticDuplicate({ proposalEmbedding: [1, 0], candidates: [{ embedding: [0, 1] }], threshold: 0.9 })).toBe(null);
      expect(findSemanticDuplicate({ proposalEmbedding: [], candidates: [{ embedding: [1] }] })).toBe(null);
      expect(findSemanticDuplicate({ proposalEmbedding: [1], candidates: [{ embedding: [] }, {}] })).toBe(null);
    });
  });
});
