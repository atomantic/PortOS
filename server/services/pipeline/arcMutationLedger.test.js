import { describe, it, expect } from 'vitest';
import { createArcMutationLedger } from './arcMutationLedger.js';

const edit = (issueId, input) => ({ issueId, idea: { input, output: '', status: 'empty' } });

describe('createArcMutationLedger', () => {
  it('hands each snapshot only the writes recorded after it was held', () => {
    const ledger = createArcMutationLedger();
    const first = ledger.hold({ marker: 'first' });
    ledger.note([edit('iss-1', 'round 1')]);
    const second = ledger.hold({ marker: 'second' });
    ledger.note([edit('iss-2', 'round 2')]);

    // A rewind to the older checkpoint has to undo BOTH rounds; the newer one
    // already contains round 1, so it owns only what came after it.
    expect(ledger.since(first)).toEqual([edit('iss-1', 'round 1'), edit('iss-2', 'round 2')]);
    expect(ledger.since(second)).toEqual([edit('iss-2', 'round 2')]);
  });

  it('reports no writes for a snapshot it never held', () => {
    const ledger = createArcMutationLedger();
    ledger.hold({ marker: 'held' });
    ledger.note([edit('iss-1', 'round 1')]);
    // Restoring nothing is the conservative answer for a snapshot this ledger
    // cannot vouch for — it must never claim ownership it has no record of.
    expect(ledger.since({ marker: 'never held' })).toEqual([]);
    expect(ledger.since(null)).toEqual([]);
  });

  it('returns the snapshot from hold, and ignores an empty or absent note', () => {
    const ledger = createArcMutationLedger();
    const snapshot = { marker: 'only' };
    expect(ledger.hold(snapshot)).toBe(snapshot);
    ledger.note([]);
    ledger.note(undefined);
    expect(ledger.since(snapshot)).toEqual([]);
  });

  it('keeps a write that a rollback already undid, for the restore to skip', () => {
    // Nothing is ever removed: an entry the restore has already reverted no
    // longer matches the value standing in the store, so it is skipped there.
    // That is what lets both callers share one ledger with no clear-on-restore
    // rule to forget.
    const ledger = createArcMutationLedger();
    const snapshot = ledger.hold({ marker: 'isolation' });
    ledger.note([edit('iss-1', 'attempt 1')]);
    expect(ledger.since(snapshot)).toEqual([edit('iss-1', 'attempt 1')]);
    ledger.note([edit('iss-1', 'attempt 2')]);
    expect(ledger.since(snapshot)).toEqual([edit('iss-1', 'attempt 1'), edit('iss-1', 'attempt 2')]);
  });
});
