import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Both the ledger and the run records are redirected into throwaway dirs. The
// service resolves `PATHS` at module load — the same reason a real restart is
// what re-reads them — so the mock has to be hoisted above the imports.
const { LEDGER_DIR, RUNS_DIR, hooks } = await vi.hoisted(async () => {
  const { mkdtempSync: mk } = await import('fs');
  const { tmpdir: tmp } = await import('os');
  const { join: j } = await import('path');
  return {
    LEDGER_DIR: mk(j(tmp(), 'portos-reconcile-ledger-')),
    RUNS_DIR: mk(j(tmp(), 'portos-reconcile-runs-')),
    // A seam for the one test that has to interleave a write between the
    // service's two reads of the same record. Nothing else installs a hook.
    hooks: { afterRecordRead: null }
  };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    PATHS: { ...actual.PATHS, cos: LEDGER_DIR, runs: RUNS_DIR },
    readJSONFile: async (path, fallback) => {
      const value = await actual.readJSONFile(path, fallback);
      if (hooks.afterRecordRead) await hooks.afterRecordRead(path);
      return value;
    }
  };
});

const { getRunReconciliation, repairRunRecords } = await import('./agentRunReconciler.js');
const { appendRunEvent, readRunEvents, __resetRunEventLogCache } = await import('./agentRunEventLog.js');

const ACTIVE = join(LEDGER_DIR, 'run-events.jsonl');
const ARCHIVE = join(LEDGER_DIR, 'run-events.1.jsonl');

const AT = '2026-08-18T12:00:00.000Z';
const LATER = '2026-08-18T12:05:00.000Z';
const NOW = '2026-08-18T13:00:00.000Z';

const metaPath = (runId) => join(RUNS_DIR, runId, 'metadata.json');

function writeRecord(runId, record) {
  mkdirSync(join(RUNS_DIR, runId), { recursive: true });
  writeFileSync(metaPath(runId), JSON.stringify({ id: runId, startTime: AT, ...record }));
}

const readRecord = (runId) => JSON.parse(readFileSync(metaPath(runId), 'utf8'));

const spawn = (runId) => appendRunEvent({ kind: 'run.spawned', runId, agentId: 'a1', taskId: 't1', at: AT, data: {} });
const finalize = (runId, success) => appendRunEvent({
  kind: 'run.finalized', runId, agentId: 'a1', at: LATER,
  data: { success, exitCode: success ? 0 : 1, durationMs: 300000 }
});

beforeEach(() => {
  for (const path of [ACTIVE, ARCHIVE]) if (existsSync(path)) rmSync(path);
  rmSync(RUNS_DIR, { recursive: true, force: true });
  mkdirSync(RUNS_DIR, { recursive: true });
  __resetRunEventLogCache();
  // Pinned next to the fixture timestamps so the ledger's 30-day age bound
  // can't age the fixtures out once the calendar passes them.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  hooks.afterRecordRead = null;
  vi.useRealTimers();
});
afterAll(() => {
  rmSync(LEDGER_DIR, { recursive: true, force: true });
  rmSync(RUNS_DIR, { recursive: true, force: true });
});

describe('getRunReconciliation', () => {
  it('reports nothing when the record matches the stream that produced it', async () => {
    writeRecord('r1', { endTime: LATER, success: true });
    await spawn('r1');
    await finalize('r1', true);

    const report = await getRunReconciliation();
    expect(report.findings).toEqual([]);
    expect(report.summary).toMatchObject({ checked: 1, repairable: 0 });
    expect(report.checkedAt).toBe(NOW);
  });

  it('finds an open record the ledger already finalized', async () => {
    writeRecord('r1', { endTime: null, success: null });
    await spawn('r1');
    await finalize('r1', false);

    const report = await getRunReconciliation();
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ runId: 'r1', finding: 'record-open', repairable: true });
  });

  it('never writes — the record is untouched by a report', async () => {
    writeRecord('r1', { endTime: null, success: null });
    await spawn('r1');
    await finalize('r1', false);

    const before = readFileSync(metaPath('r1'), 'utf8');
    await getRunReconciliation();
    expect(readFileSync(metaPath('r1'), 'utf8')).toBe(before);
  });

  it('narrows to one run when asked', async () => {
    writeRecord('r1', { endTime: null });
    writeRecord('r2', { endTime: null });
    await spawn('r1'); await finalize('r1', false);
    await spawn('r2'); await finalize('r2', false);

    const report = await getRunReconciliation({ runId: 'r2' });
    expect(report.summary.checked).toBe(1);
    expect(report.findings.map((f) => f.runId)).toEqual(['r2']);
  });

  it('reports a run the ledger knows but that has no record on disk', async () => {
    await spawn('gone');
    await finalize('gone', true);

    const report = await getRunReconciliation();
    expect(report.findings[0]).toMatchObject({ runId: 'gone', finding: 'record-missing', repairable: false });
  });
});

describe('repairRunRecords', () => {
  it('closes an open record with the ledger verdict and records the repair as an event', async () => {
    writeRecord('r1', { endTime: null, success: null });
    await spawn('r1');
    await finalize('r1', false);

    const result = await repairRunRecords();
    expect(result.repaired).toEqual([{ runId: 'r1', from: 'failed', success: false, endTime: LATER }]);

    const record = readRecord('r1');
    expect(record).toMatchObject({ endTime: LATER, success: false, exitCode: 1, reconciledFromLedger: true, reconciledAt: NOW });
    // The run's own fields survive the merge — a repair closes a record, it
    // does not replace it.
    expect(record.startTime).toBe(AT);

    const events = await readRunEvents({ runId: 'r1', kind: 'run.reconciled' });
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ fromStatus: 'failed', success: false });
  });

  it('is idempotent — a second pass finds the record already closed', async () => {
    writeRecord('r1', { endTime: null, success: null });
    await spawn('r1');
    await finalize('r1', false);

    await repairRunRecords();
    const after = readFileSync(metaPath('r1'), 'utf8');
    const second = await repairRunRecords();

    expect(second.repaired).toEqual([]);
    expect(second.findings).toEqual([]);
    expect(readFileSync(metaPath('r1'), 'utf8')).toBe(after);
    expect(await readRunEvents({ runId: 'r1', kind: 'run.reconciled' })).toHaveLength(1);
  });

  it('leaves a run that closed itself between the report and the write alone', async () => {
    writeRecord('r1', { endTime: null, success: null });
    await spawn('r1');
    await finalize('r1', false);

    // The run's own completion path landing mid-pass. It fires after the
    // reconciler's FIRST read of the record (which still sees it open, so the
    // finding is genuinely 'record-open' and repairable) and before the fresh
    // read the repair loop takes — which is the read that has to notice.
    let reads = 0;
    hooks.afterRecordRead = (path) => {
      if (!path.includes('r1')) return;
      reads += 1;
      if (reads === 1) writeRecord('r1', { endTime: LATER, success: true, duration: 1 });
    };

    const result = await repairRunRecords();
    hooks.afterRecordRead = null;
    expect(reads).toBeGreaterThan(1);
    expect(result.repaired).toEqual([]);
    expect(result.skipped).toBe(1);
    expect(readRecord('r1')).toMatchObject({ success: true, duration: 1 });
    expect(readRecord('r1').reconciledFromLedger).toBeUndefined();
  });

  it('does not repair a verdict mismatch — the record verdict stands', async () => {
    writeRecord('r1', { endTime: LATER, success: false });
    await spawn('r1');
    await finalize('r1', true);

    const result = await repairRunRecords();
    expect(result.repaired).toEqual([]);
    expect(result.findings[0].finding).toBe('verdict-mismatch');
    expect(readRecord('r1').success).toBe(false);
  });

  it('does not invent a ledger event for a close the ledger missed', async () => {
    writeRecord('r1', { endTime: LATER, success: true });
    await spawn('r1');

    const result = await repairRunRecords();
    expect(result.findings[0].finding).toBe('ledger-open');
    expect(result.repaired).toEqual([]);
    expect(await readRunEvents({ runId: 'r1', kind: 'run.finalized' })).toEqual([]);
  });

  it('closes an orphaned run as a failure even with no verdict event', async () => {
    writeRecord('r1', { endTime: null, success: null });
    await spawn('r1');
    await appendRunEvent({ kind: 'run.orphan-recovered', runId: 'r1', agentId: 'a1', at: LATER, data: { pid: 4242 } });

    const result = await repairRunRecords();
    expect(result.repaired[0]).toMatchObject({ runId: 'r1', from: 'orphaned', success: false });
    const record = readRecord('r1');
    expect(record.success).toBe(false);
    expect(record.error).toContain('reconciliation');
  });

  it('runs one pass at a time', async () => {
    writeRecord('r1', { endTime: null, success: null });
    await spawn('r1');
    await finalize('r1', false);

    const [a, b] = await Promise.all([repairRunRecords(), repairRunRecords()]);
    // The second call joins the first rather than planning the same repair from
    // records the first has not written yet.
    expect(b).toBe(a);
    expect(a.repaired).toHaveLength(1);
  });
});
