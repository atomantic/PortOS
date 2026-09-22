/**
 * The cross-version contract for the archive's completion-order sidecar (#7968).
 * Nothing above this module can pin it: the pagination and feedback suites only
 * ever meet a document this same code wrote, so a document written by a NEWER
 * install — or a write truncated mid-flight — is exercised only here.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPLETION_ORDER_VERSION,
  decodeCompletionOrder,
  encodeCompletionOrder,
  projectArchivedAgent,
  sameCompletionProjection,
} from './cosAgentCompletionOrder.js';

const projection = (overrides = {}) => ({
  completedAt: '2026-05-06T08:00:00.000Z', completed: true, feedbackEligible: true, ...overrides,
});

describe('completion-order projection', () => {
  it('records completion order and whether the run is still an answerable feedback ask', () => {
    const base = { id: 'agent-example', status: 'completed', completedAt: '2026-05-06T08:00:00.000Z', metadata: { taskType: 'user' } };
    expect(projectArchivedAgent(base)).toEqual(projection());
    expect(projectArchivedAgent({ ...base, feedback: { rating: 'neutral' } }).feedbackEligible).toBe(false);
    expect(projectArchivedAgent({ ...base, metadata: { taskType: 'internal' } }).feedbackEligible).toBe(false);
    expect(projectArchivedAgent({ ...base, status: 'running' })).toMatchObject({ completed: false, feedbackEligible: false });
    // Archives written before `status` was persisted read as completed, matching
    // the archive reader — otherwise they would silently drop out of history.
    expect(projectArchivedAgent({ ...base, status: undefined }).completed).toBe(true);
    // A completed record with no timestamp still orders (last within its day).
    expect(projectArchivedAgent({ ...base, completedAt: undefined }).completedAt).toBeNull();
  });
});

describe('completion-order document', () => {
  it('round-trips every projection through the compact encoding', () => {
    const source = new Map([
      ['agent-a', projection()],
      ['agent-b', projection({ feedbackEligible: false })],
      ['agent-c', projection({ completedAt: null, completed: false, feedbackEligible: false })],
    ]);
    expect(decodeCompletionOrder(encodeCompletionOrder(source))).toEqual(source);
  });

  it('decodes a document from an unrecognized version as absent rather than misreading it', () => {
    const encoded = encodeCompletionOrder(new Map([['agent-a', projection()]]));
    expect(decodeCompletionOrder({ ...encoded, version: COMPLETION_ORDER_VERSION + 1 }).size).toBe(0);
    expect(decodeCompletionOrder({ ...encoded, version: undefined }).size).toBe(0);
    expect(decodeCompletionOrder(null).size).toBe(0);
    expect(decodeCompletionOrder({ version: COMPLETION_ORDER_VERSION, entries: [] }).size).toBe(0);
  });

  it('skips a malformed row instead of admitting it with invented values', () => {
    const decoded = decodeCompletionOrder({
      version: COMPLETION_ORDER_VERSION,
      entries: {
        'agent-ok': ['2026-05-06T08:00:00.000Z', 3],
        'agent-short': ['2026-05-06T08:00:00.000Z'],
        'agent-bad-flags': ['2026-05-06T08:00:00.000Z', 'eligible'],
        'agent-bad-stamp': [1746518400000, 3],
      },
    });
    expect([...decoded.keys()]).toEqual(['agent-ok']);
  });

  it('treats an unknown id as different from every projection, so a first write is never skipped', () => {
    expect(sameCompletionProjection(undefined, projection())).toBe(false);
    expect(sameCompletionProjection(projection(), projection())).toBe(true);
    expect(sameCompletionProjection(projection(), projection({ feedbackEligible: false }))).toBe(false);
  });
});
