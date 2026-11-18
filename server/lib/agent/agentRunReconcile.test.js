import { describe, it, expect } from 'vitest';
import {
  RUN_RECONCILE_FINDINGS,
  isAgentFallbackKey,
  diffRunRecord,
  reconcileRunRecords,
  planRunRecordRepair
} from './agentRunReconcile.js';
import { projectRunStates, buildRunEvent } from './agentRunEvents.js';

const AT = '2026-08-18T12:00:00.000Z';
const LATER = '2026-08-18T12:05:00.000Z';
const REPAIR_AT = '2026-08-18T13:00:00.000Z';

/**
 * Projections are built by FOLDING real events rather than hand-written, so a
 * change to the fold that breaks reconciliation fails here instead of shipping
 * a diff engine that reads fields the projection no longer produces.
 */
const project = (events) => projectRunStates(events.map(buildRunEvent));

const spawned = (runId = 'r1') => ({ kind: 'run.spawned', runId, agentId: 'a1', taskId: 't1', at: AT });
const finalized = (success, runId = 'r1') => ({
  kind: 'run.finalized', runId, agentId: 'a1', at: LATER, data: { success, exitCode: success ? 0 : 1, durationMs: 300000 }
});
const orphaned = (runId = 'r1') => ({ kind: 'run.orphan-recovered', runId, agentId: 'a1', at: LATER, data: { pid: 4242 } });

const openRecord = (extra = {}) => ({ id: 'r1', startTime: AT, endTime: null, success: null, ...extra });
const closedRecord = (success, extra = {}) => ({ id: 'r1', startTime: AT, endTime: LATER, success, ...extra });

const one = (events) => project(events)[0];

describe('diffRunRecord', () => {
  it('reports nothing when an open record matches a still-running ledger', () => {
    expect(diffRunRecord(one([spawned()]), openRecord())).toBeNull();
  });

  it('reports nothing when both sides agree the run succeeded', () => {
    expect(diffRunRecord(one([spawned(), finalized(true)]), closedRecord(true))).toBeNull();
  });

  it('flags an open record the ledger has already finalized, and calls it repairable', () => {
    const diff = diffRunRecord(one([spawned(), finalized(false)]), openRecord());
    expect(diff).toMatchObject({ finding: 'record-open', repairable: true });
    expect(diff.detail).toMatchObject({ ledgerStatus: 'failed', ledgerSuccess: false, ledgerEndedAt: LATER });
  });

  it('treats an orphaned run as a failure even though no verdict event exists', () => {
    const diff = diffRunRecord(one([spawned(), orphaned()]), openRecord());
    expect(diff).toMatchObject({ finding: 'record-open', repairable: true });
    expect(diff.detail.ledgerSuccess).toBe(false);
  });

  it('flags a run the ledger knows but no record exists for, and refuses to repair it', () => {
    const diff = diffRunRecord(one([spawned(), finalized(true)]), null);
    expect(diff).toMatchObject({ finding: 'record-missing', repairable: false });
  });

  it('reports a missing record even when the spawn event has aged out', () => {
    // Retention drops the oldest events first, so a run whose `run.spawned` is
    // gone but whose `run.finalized` is still in the ledger is the NORMAL shape
    // of an old run — and a finalized run with no record on disk is exactly the
    // drift worth naming.
    const finalizeOnly = one([finalized(true)]);
    expect(finalizeOnly.startedAt).toBeNull();
    expect(diffRunRecord(finalizeOnly, null)).toMatchObject({ finding: 'record-missing' });
  });

  it('does not report a missing record for a projection with no status opinion', () => {
    const annotationOnly = one([{ kind: 'run.pr-verified', runId: 'r1', at: AT, data: { verified: true } }]);
    expect(annotationOnly.status).toBe('unknown');
    expect(diffRunRecord(annotationOnly, null)).toBeNull();
  });

  it('flags disagreeing verdicts without proposing a repair', () => {
    const diff = diffRunRecord(one([spawned(), finalized(true)]), closedRecord(false));
    expect(diff).toMatchObject({ finding: 'verdict-mismatch', repairable: false });
    expect(diff.detail).toMatchObject({ ledgerSuccess: true, recordSuccess: false });
  });

  it('flags a closed record whose close never reached the ledger', () => {
    const diff = diffRunRecord(one([spawned()]), closedRecord(true));
    expect(diff).toMatchObject({ finding: 'ledger-open', repairable: false });
    expect(diff.detail).toMatchObject({ ledgerStatus: 'running', recordEndedAt: LATER });
  });

  it('says nothing about a projection with no status opinion', () => {
    // `unknown` belongs to none of the status sets: an annotation-only stream
    // makes no claim about whether the run is open, so pairing it with a closed
    // record is not a finding.
    const annotationOnly = one([{ kind: 'run.pr-verified', runId: 'r1', at: AT, data: { verified: true } }]);
    expect(annotationOnly.status).toBe('unknown');
    expect(diffRunRecord(annotationOnly, closedRecord(true))).toBeNull();
  });

  it('skips the agent:<id> fallback key, which can have no run record', () => {
    const agentOnly = one([{ kind: 'run.orphan-recovered', agentId: 'a9', at: AT, data: {} }]);
    expect(isAgentFallbackKey(agentOnly.id)).toBe(true);
    expect(diffRunRecord(agentOnly, null)).toBeNull();
  });

  it('only ever emits findings from the closed vocabulary', () => {
    const cases = [
      [one([spawned(), finalized(false)]), openRecord()],
      [one([spawned(), finalized(true)]), null],
      [one([spawned(), finalized(true)]), closedRecord(false)],
      [one([spawned()]), closedRecord(true)]
    ];
    for (const [projection, record] of cases) {
      expect(RUN_RECONCILE_FINDINGS).toContain(diffRunRecord(projection, record).finding);
    }
  });
});

describe('reconcileRunRecords', () => {
  it('zero-fills every finding count so a healthy install reads 0, not undefined', () => {
    const { findings, summary } = reconcileRunRecords({
      projections: project([spawned(), finalized(true)]),
      records: new Map([['r1', closedRecord(true)]])
    });
    expect(findings).toEqual([]);
    expect(summary.checked).toBe(1);
    for (const kind of RUN_RECONCILE_FINDINGS) expect(summary.byFinding[kind]).toBe(0);
  });

  it('counts repairable findings separately and carries the run ids through', () => {
    const projections = project([
      spawned('r1'), finalized(false, 'r1'),
      spawned('r2'), finalized(true, 'r2')
    ]);
    const { findings, summary } = reconcileRunRecords({
      projections,
      records: new Map([['r1', openRecord()], ['r2', { id: 'r2', startTime: AT, endTime: LATER, success: false }]])
    });
    expect(summary).toMatchObject({ checked: 2, findings: 2, repairable: 1 });
    expect(summary.byFinding['record-open']).toBe(1);
    expect(summary.byFinding['verdict-mismatch']).toBe(1);
    expect(findings.map((f) => f.runId).sort()).toEqual(['r1', 'r2']);
    expect(findings.every((f) => f.agentId === 'a1')).toBe(true);
  });

  it('counts agent-only projections rather than checking them', () => {
    const projections = project([{ kind: 'run.orphan-recovered', agentId: 'a9', at: AT, data: {} }]);
    const { findings, summary } = reconcileRunRecords({ projections, records: new Map() });
    expect(findings).toEqual([]);
    expect(summary).toMatchObject({ checked: 0, agentOnly: 1 });
  });

  it('treats a record absent from the map the same as an explicit null', () => {
    const projections = project([spawned(), finalized(true)]);
    const viaNull = reconcileRunRecords({ projections, records: new Map([['r1', null]]) });
    const viaAbsent = reconcileRunRecords({ projections, records: new Map() });
    expect(viaAbsent.findings).toEqual(viaNull.findings);
    expect(viaNull.findings[0].finding).toBe('record-missing');
  });

  it('tolerates being called with nothing', () => {
    expect(reconcileRunRecords().summary).toMatchObject({ checked: 0, findings: 0, repairable: 0 });
  });
});

describe('planRunRecordRepair', () => {
  it('closes an open record with the ledger verdict and derives the duration', () => {
    const patch = planRunRecordRepair(one([spawned(), finalized(false)]), openRecord(), REPAIR_AT);
    expect(patch).toMatchObject({
      endTime: LATER,
      success: false,
      exitCode: 1,
      duration: 300000,
      reconciledFromLedger: true,
      reconciledAt: REPAIR_AT,
      reconciledFromStatus: 'failed'
    });
    expect(patch.error).toContain('reconciliation');
    expect(patch.errorCategory).toBe('reconciled');
  });

  it('derives the duration from the record start when the ledger has none', () => {
    const patch = planRunRecordRepair(one([spawned(), orphaned()]), openRecord(), REPAIR_AT);
    expect(patch.duration).toBe(Date.parse(LATER) - Date.parse(AT));
    expect(patch.endTime).toBe(LATER);
    expect(patch.success).toBe(false);
  });

  it('leaves a successful repair without a fabricated error', () => {
    const patch = planRunRecordRepair(one([spawned(), finalized(true)]), openRecord(), REPAIR_AT);
    expect(patch.success).toBe(true);
    expect(patch.error).toBeUndefined();
    expect(patch.errorCategory).toBeUndefined();
  });

  it('keeps the record own error text when it already has one', () => {
    const patch = planRunRecordRepair(
      one([spawned(), finalized(false)]),
      openRecord({ error: 'Provider quota exhausted', errorCategory: 'quota' }),
      REPAIR_AT
    );
    expect(patch.error).toBe('Provider quota exhausted');
    expect(patch.errorCategory).toBe('quota');
  });

  it('never plans a repair for a finding that is not record-open', () => {
    expect(planRunRecordRepair(one([spawned(), finalized(true)]), null, REPAIR_AT)).toBeNull();
    expect(planRunRecordRepair(one([spawned(), finalized(true)]), closedRecord(false), REPAIR_AT)).toBeNull();
    expect(planRunRecordRepair(one([spawned()]), closedRecord(true), REPAIR_AT)).toBeNull();
    expect(planRunRecordRepair(one([spawned()]), openRecord(), REPAIR_AT)).toBeNull();
  });

  it('falls back to the repair time rather than closing a record with a null endTime', () => {
    // A finalize whose projection carries no end stamp cannot happen through
    // `run.finalized`, so this drives the fallback through an orphan-only
    // stream with its own `at` stripped by the projection's key fallback.
    const projection = { ...one([spawned(), orphaned()]), endedAt: null, lastEventAt: null };
    expect(planRunRecordRepair(projection, openRecord(), REPAIR_AT).endTime).toBe(REPAIR_AT);
  });
});
