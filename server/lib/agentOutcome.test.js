import { describe, it, expect } from 'vitest';
import { isAgentHandoff, isAgentOutcome, isAgentFailure } from './agentOutcome.js';

// The record `resumeAgent` retires when Relaunch swaps providers mid-run: it
// carries `success: false` and a summary in `error`, because the pause/requeue
// path reuses the completion shape. Every consumer that read `success` alone
// booked that as a failure.
const handoff = {
  status: 'completed',
  result: { success: false, resumed: true, resumedTaskId: 'task-1', error: 'Relaunched by user on codex / gpt-5' },
};
const failure = { status: 'completed', result: { success: false, error: 'exit code 1' } };
const win = { status: 'completed', result: { success: true } };

describe('agentOutcome', () => {
  it('reads a relaunch retirement as a handoff, not a failure', () => {
    expect(isAgentHandoff(handoff)).toBe(true);
    expect(isAgentOutcome(handoff)).toBe(false);
    expect(isAgentFailure(handoff)).toBe(false);
  });

  // The bypass probe. A predicate that classified EVERYTHING as "not a failure"
  // would pass the assertion above while silently emptying the failure bucket of
  // every report, digest, and success rate that now filters on it.
  it('still reads a genuine failure as a failure', () => {
    expect(isAgentHandoff(failure)).toBe(false);
    expect(isAgentOutcome(failure)).toBe(true);
    expect(isAgentFailure(failure)).toBe(true);
  });

  it('reads a successful run as an outcome that did not fail', () => {
    expect(isAgentHandoff(win)).toBe(false);
    expect(isAgentOutcome(win)).toBe(true);
    expect(isAgentFailure(win)).toBe(false);
  });

  // `resumed` is the field `resumeAgent` has always stamped, which is what makes
  // already-archived relaunches reclassify without a migration — but only under a
  // STRICT read. A truthy check would also catch a future `resumed: 'partial'`
  // or a COS-TASKS.md round-trip's string, and quietly drop a real outcome from
  // every count.
  it('demands the boolean, so a nearby truthy value is not mistaken for a handoff', () => {
    expect(isAgentHandoff({ result: { success: false, resumed: 'true' } })).toBe(false);
    expect(isAgentHandoff({ result: { success: false, resumed: 1 } })).toBe(false);
  });

  // A running agent has no `result` yet. It is not an outcome (nothing to count)
  // and must not be reported as a failure by a caller that only asks "did it fail".
  it('treats a record with no result as neither an outcome nor a failure', () => {
    for (const record of [{ status: 'running' }, {}, null, undefined]) {
      expect(isAgentOutcome(record)).toBe(false);
      expect(isAgentFailure(record)).toBe(false);
      expect(isAgentHandoff(record)).toBe(false);
    }
  });
});
