/**
 * The handoff predicate, and cross-package parity for its client mirror.
 *
 * `server/lib/agentOutcome.js` is the source of truth; `client/src/lib/agentOutcome.js`
 * is a hand-maintained copy, because the client must not import out of the server
 * tree. Both are pure, so ONE table runs against BOTH and a copy that drifts fails
 * here instead of quietly letting the run card disagree with the daily report about
 * whether a provider swap was a failure.
 *
 * It lives server-side, like the repo's other parity suites, because the server
 * runner can load the pure client module but not the reverse.
 */

import { describe, it, expect } from 'vitest';
import { isAgentHandoff as serverIsAgentHandoff } from './agentOutcome.js';
import { isAgentHandoff as clientIsAgentHandoff, agentHandoffReason } from '../../client/src/lib/agentOutcome.js';

const IMPLEMENTATIONS = [['server', serverIsAgentHandoff], ['client', clientIsAgentHandoff]];

// The record `resumeAgent` retires when Relaunch swaps providers mid-run: it
// carries `success: false` and a summary in `error`, because the pause/requeue
// path reuses the completion shape. Every consumer that read `success` alone
// booked that as a failure.
const HANDOFF = {
  status: 'completed',
  result: { success: false, resumed: true, resumedTaskId: 'task-1', error: 'Relaunched by user on codex / gpt-5' },
};

const CASES = [
  ['a relaunch retirement', HANDOFF, true],
  // The bypass probe. A predicate that answered `false` for everything would pass
  // the case above while silently emptying the failure bucket of every report,
  // digest, and success rate that now filters on it.
  ['a genuine failure', { status: 'completed', result: { success: false, error: 'exit code 1' } }, false],
  ['a successful run', { status: 'completed', result: { success: true } }, false],
  // `resumed` is the field that makes archived relaunches reclassify without a
  // migration — but only under a STRICT read. A truthy check would also catch a
  // future `resumed: 'partial'` or a COS-TASKS.md round-trip's string and drop a
  // real outcome from every count.
  ['a string "true" in the resumed slot', { result: { success: false, resumed: 'true' } }, false],
  ['a 1 in the resumed slot', { result: { success: false, resumed: 1 } }, false],
  // A running agent has no result yet, and must not read as a handoff to a caller
  // deciding whether to advance a chain.
  ['a running agent', { status: 'running' }, false],
  ['an empty record', {}, false],
  ['null', null, false],
  ['undefined', undefined, false],
];

describe.each(IMPLEMENTATIONS)('isAgentHandoff (%s)', (_side, isAgentHandoff) => {
  it.each(CASES)('reads %s as %s', (_label, record, expected) => {
    expect(isAgentHandoff(record)).toBe(expected);
  });
});

describe('agentHandoffReason (client-only)', () => {
  it('prefers the pause reason when a continuation was actually queued', () => {
    // `result.error` there is `resumeAgent`'s summary — "task … requeued on
    // <branch>" — which answers a question nobody asked while looking at the run
    // they just relaunched.
    expect(agentHandoffReason({
      metadata: { pauseReason: 'Relaunched by user on codex / gpt-5' },
      result: { resumed: true, resumedTaskId: 'task-1', error: 'Resumed agent agent-1 — task task-1 requeued on cos/task-1/agent-1' },
    })).toBe('Relaunched by user on codex / gpt-5');
  });

  it('prefers the retirement reason when NOTHING was queued', () => {
    // `retireStrandedPausedAgents` stamps `resumed: true` with no `resumedTaskId`
    // on a pause whose task is gone. Its `pauseReason` is the ORIGINAL one, so
    // preferring it would caption an abandoned run as a deliberate provider swap.
    expect(agentHandoffReason({
      metadata: { pauseReason: 'Paused by user' },
      result: { resumed: true, error: 'Pause retired — its task task-9 no longer exists' },
    })).toBe('Pause retired — its task task-9 no longer exists');
  });

  it('falls back through to a generic line', () => {
    expect(agentHandoffReason({ result: { resumed: true, resumedTaskId: 't1' }, metadata: {} })).toBe('Handed off to a new run');
    expect(agentHandoffReason({ result: { resumed: true } })).toBe('Handed off to a new run');
  });
});
