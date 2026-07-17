import { describe, it, expect } from 'vitest';
import {
  computeReviewVerdict,
  collectReviewFindings,
  shapeFeedbackFinding,
  buildFeedbackRoutePrompt,
} from './seriesReview.js';

describe('computeReviewVerdict', () => {
  it("is 'ready' when health is clean, foundation clears the threshold, and canon is ready", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 8.2 },
      canon: { ready: true },
      threshold: 7.5,
    })).toBe('ready');
  });

  it("is 'issues' when the health gate is not clean", () => {
    expect(computeReviewVerdict({
      health: { ready: false },
      foundation: { weightedScore: 9 },
      canon: { ready: true },
    })).toBe('issues');
  });

  it("is 'issues' when the foundation is below the threshold", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 6 },
      canon: { ready: true },
      threshold: 7.5,
    })).toBe('issues');
  });

  it("is 'issues' when canon is not ready", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 9 },
      canon: { ready: false },
    })).toBe('issues');
  });

  it('treats a missing foundation / canon as non-blocking (absent, not failing)', () => {
    expect(computeReviewVerdict({ health: { ready: true }, foundation: null, canon: null })).toBe('ready');
  });

  it('treats a non-finite foundation score as non-blocking', () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: NaN },
      canon: { ready: true },
    })).toBe('ready');
  });

  it("is 'issues' when the review is incomplete (a stage errored / never ran — must not read ready)", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 9 },
      canon: { ready: true },
      incomplete: true,
    })).toBe('issues');
  });

  it("is 'ready' when complete and all dimensions pass (incomplete false)", () => {
    expect(computeReviewVerdict({
      health: { ready: true },
      foundation: { weightedScore: 9 },
      canon: { ready: true },
      incomplete: false,
    })).toBe('ready');
  });
});

describe('collectReviewFindings', () => {
  const comments = [
    { id: 'a', severity: 'low', status: 'open', issueNumber: 2, problem: 'nit', checkId: 'style' },
    { id: 'b', severity: 'high', status: 'open', issueNumber: 3, problem: 'big', checkId: 'continuity', anchorQuote: 'q', location: 'V1' },
    { id: 'c', severity: 'high', status: 'open', issueNumber: 1, problem: 'also big' },
    { id: 'd', severity: 'medium', status: 'accepted', issueNumber: 1, problem: 'fixed already' },
    { id: 'e', severity: 'medium', status: 'dismissed', issueNumber: 1, problem: 'waived' },
  ];

  it('keeps only OPEN findings (drops accepted + dismissed)', () => {
    const out = collectReviewFindings(comments);
    expect(out.map((f) => f.commentId)).not.toContain('d');
    expect(out.map((f) => f.commentId)).not.toContain('e');
    expect(out).toHaveLength(3);
  });

  it('sorts high→low severity, then by issue number', () => {
    const out = collectReviewFindings(comments);
    // Both highs first (issue 1 before 3), then the low.
    expect(out.map((f) => f.commentId)).toEqual(['c', 'b', 'a']);
  });

  it('surfaces the commentId + anchoring fields the fix path needs', () => {
    const out = collectReviewFindings(comments);
    const b = out.find((f) => f.commentId === 'b');
    expect(b).toMatchObject({ severity: 'high', issueNumber: 3, anchorQuote: 'q', location: 'V1', summary: 'big', checkId: 'continuity' });
  });

  it('tolerates a non-array input', () => {
    expect(collectReviewFindings(null)).toEqual([]);
  });
});

describe('shapeFeedbackFinding', () => {
  const validNumbers = new Set([1, 2, 3]);

  it('adopts a valid routed issue number + severity', () => {
    const f = shapeFeedbackFinding(
      { issueNumber: 2, severity: 'high', problem: 'pacing drags', suggestion: 'cut', location: 'V2', anchorQuote: 'the quiet' },
      { feedback: 'raw', validNumbers },
    );
    expect(f).toMatchObject({
      issueNumber: 2, severity: 'high', problem: 'pacing drags', suggestion: 'cut', location: 'V2', anchorQuote: 'the quiet',
      checkId: 'user-feedback', category: 'user-feedback',
    });
  });

  it('degrades a hallucinated issue number to a series-level (null) finding', () => {
    const f = shapeFeedbackFinding({ issueNumber: 99, problem: 'x' }, { feedback: 'raw', validNumbers });
    expect(f.issueNumber).toBeNull();
  });

  it('falls back to the raw feedback as the problem when the model omits it', () => {
    const f = shapeFeedbackFinding({}, { feedback: 'volume 1 has no real development', validNumbers });
    expect(f.problem).toBe('volume 1 has no real development');
    expect(f.severity).toBe('medium');
    expect(f.issueNumber).toBeNull();
  });

  it('defaults an invalid severity to medium', () => {
    const f = shapeFeedbackFinding({ severity: 'critical', problem: 'x' }, { feedback: 'raw', validNumbers });
    expect(f.severity).toBe('medium');
  });

  it('accepts an array of valid numbers (not only a Set)', () => {
    const f = shapeFeedbackFinding({ issueNumber: 3, problem: 'x' }, { feedback: 'raw', validNumbers: [1, 2, 3] });
    expect(f.issueNumber).toBe(3);
  });
});

describe('buildFeedbackRoutePrompt', () => {
  it('lists the issue roster and embeds the feedback', () => {
    const prompt = buildFeedbackRoutePrompt('check the pacing', [
      { number: 1, title: 'Origins' },
      { number: 2, title: 'Fallout' },
    ]);
    expect(prompt).toContain('#1: Origins');
    expect(prompt).toContain('#2: Fallout');
    expect(prompt).toContain('check the pacing');
    expect(prompt).toContain('issueNumber');
  });

  it('handles an empty roster', () => {
    const prompt = buildFeedbackRoutePrompt('note', []);
    expect(prompt).toContain('(no issues yet)');
  });
});
