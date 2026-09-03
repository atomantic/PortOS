import { describe, it, expect } from 'vitest';
import { mergeGateOwed, summaryStatesLeaveOpen, resolveMergeGateVerdict, buildMergeGateReprompt } from './mergeGateContract.js';

describe('mergeGateOwed', () => {
  it('is owed only when the task asked for a PR, the agent owns the workflow, and nobody hands it to a human', () => {
    expect(mergeGateOwed({ taskOpenPR: true, ownsPrWorkflow: true, leaveOpen: false })).toBe(true);
  });

  it('is not owed when the task never asked for a PR (PortOS still backstops it)', () => {
    expect(mergeGateOwed({ taskOpenPR: false, ownsPrWorkflow: true, leaveOpen: false })).toBe(false);
  });

  it('is not owed when the agent does not own the PR workflow (a lean --bare session)', () => {
    expect(mergeGateOwed({ taskOpenPR: true, ownsPrWorkflow: false, leaveOpen: false })).toBe(false);
  });

  it('is not owed when the task hands the PR to a human (JIRA, claim flow)', () => {
    expect(mergeGateOwed({ taskOpenPR: true, ownsPrWorkflow: true, leaveOpen: true })).toBe(false);
  });

  it('is not owed for a read-only / no-code-output run (neither openPR nor ownership)', () => {
    expect(mergeGateOwed({ taskOpenPR: false, ownsPrWorkflow: false, leaveOpen: false })).toBe(false);
  });
});

describe('summaryStatesLeaveOpen', () => {
  it('is false for an empty or missing summary', () => {
    expect(summaryStatesLeaveOpen(null)).toBe(false);
    expect(summaryStatesLeaveOpen(undefined)).toBe(false);
    expect(summaryStatesLeaveOpen('')).toBe(false);
  });

  it('is false for a plain shipped-it summary', () => {
    expect(summaryStatesLeaveOpen('Shipped the fix and opened the PR.')).toBe(false);
  });

  it.each([
    'A required check is still red after two fix attempts — leaving the PR open for a human.',
    'Left the merge request open because of an unresolved conflict.',
    'I did not merge because branch protection blocked it.',
    'Required review is review-blocked, so the PR stays open.',
  ])('recognizes a stated leave-open decision: %s', (summary) => {
    expect(summaryStatesLeaveOpen(summary)).toBe(true);
  });
});

describe('resolveMergeGateVerdict', () => {
  const summary = 'Shipped the fix and opened the PR.';

  it('is "merged" when the PR landed', () => {
    expect(resolveMergeGateVerdict({
      prProbe: { prState: 'MERGED', readable: true }, summary,
    })).toBe('merged');
  });

  it('is "no-pr-action" when the forge lookup itself failed', () => {
    expect(resolveMergeGateVerdict({
      prProbe: { prState: null, readable: false }, summary,
    })).toBe('no-pr-action');
  });

  it('is "no-pr-action" when there is no probe result at all', () => {
    expect(resolveMergeGateVerdict({ prProbe: null, summary })).toBe('no-pr-action');
  });

  it('is "no-pr-action" when the forge found no PR for the branch', () => {
    expect(resolveMergeGateVerdict({
      prProbe: { prState: null, readable: true }, summary,
    })).toBe('no-pr-action');
  });

  it('is "no-pr-action" when the PR is closed rather than merged', () => {
    expect(resolveMergeGateVerdict({
      prProbe: { prState: 'CLOSED', readable: true }, summary,
    })).toBe('no-pr-action');
  });

  it('is "leave-open-stated" when the PR is open and the summary says so', () => {
    expect(resolveMergeGateVerdict({
      prProbe: { prState: 'OPEN', readable: true },
      summary: 'Leaving the PR open — CI is still red.',
    })).toBe('leave-open-stated');
  });

  it('is "needs-reprompt" when the PR is open and no blocker is stated', () => {
    expect(resolveMergeGateVerdict({
      prProbe: { prState: 'OPEN', readable: true }, summary,
    })).toBe('needs-reprompt');
  });
});

describe('buildMergeGateReprompt', () => {
  it('names the PR URL and points back at the Merge Gate steps', () => {
    const text = buildMergeGateReprompt('https://example.com/pr/1');
    expect(text).toContain('https://example.com/pr/1');
    expect(text).toContain('Merge Gate');
    expect(text.toLowerCase()).toContain('merged');
  });
});
