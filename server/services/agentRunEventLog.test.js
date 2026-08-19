import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Point PATHS.cos at a throwaway dir so the suite never touches the real
// install's ledger. Hoisted because the service resolves its file paths at
// module load — the same reason a real restart is what re-reads them.
// (async so the hoisted factory can `import` — hoisting runs it before this
// module's own static imports have initialized.)
const { LEDGER_DIR } = await vi.hoisted(async () => {
  const { mkdtempSync: mk } = await import('fs');
  const { tmpdir: tmp } = await import('os');
  const { join: j } = await import('path');
  return { LEDGER_DIR: mk(j(tmp(), 'portos-run-events-')) };
});

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, cos: LEDGER_DIR } };
});

const {
  appendRunEvent,
  readRunEvents,
  getRunProjections,
  getRunDiagnostic,
  getRunEventLedgerStats,
  flushRunEvents,
  __resetRunEventLogCache,
  MAX_ACTIVE_EVENTS
} = await import('./agentRunEventLog.js');
const { buildRunEvent } = await import('../lib/agentRunEvents.js');

const ACTIVE = join(LEDGER_DIR, 'run-events.jsonl');
const ARCHIVE = join(LEDGER_DIR, 'run-events.1.jsonl');

/** Wipe the on-disk ledger AND the in-process caches — i.e. a fresh install. */
function resetLedger() {
  for (const path of [ACTIVE, ARCHIVE]) if (existsSync(path)) rmSync(path);
  __resetRunEventLogCache();
}

/** Drop only the in-process caches — i.e. a server restart over the same disk. */
const restartServer = () => __resetRunEventLogCache();

const countLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0);

beforeEach(resetLedger);
afterAll(() => rmSync(LEDGER_DIR, { recursive: true, force: true }));

describe('appendRunEvent', () => {
  it('appends one JSON line per event, in call order', async () => {
    await appendRunEvent({ kind: 'run.spawned', runId: 'r1', agentId: 'a1', at: '2026-08-18T10:00:00.000Z' });
    await appendRunEvent({ kind: 'run.finalized', runId: 'r1', at: '2026-08-18T11:00:00.000Z', data: { success: true, exitCode: 0 } });

    const events = await readRunEvents();
    expect(events.map((e) => e.kind)).toEqual(['run.spawned', 'run.finalized']);
    expect(countLines(ACTIVE)).toBe(2);
  });

  it('serializes concurrent appends so the file order matches the call order', async () => {
    // Several lifecycle boundaries can fire at once; interleaved appends would
    // both read the seen-id set before either wrote, defeating deduplication.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        appendRunEvent({ kind: 'run.spawned', runId: `r${i}`, at: `2026-08-18T10:00:${String(i).padStart(2, '0')}.000Z` })
      )
    );
    const events = await readRunEvents();
    expect(events).toHaveLength(20);
    expect(events.map((e) => e.runId)).toEqual(Array.from({ length: 20 }, (_, i) => `r${i}`));
  });

  it('never rejects when the envelope is invalid — telemetry cannot fail a run', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await appendRunEvent({ kind: 'not-a-kind', runId: 'r1' });
    expect(result.appended).toBe(false);
    expect(result.error).toBeTruthy();
    expect(await readRunEvents()).toEqual([]);
    // A later good append still lands — one bad envelope must not wedge the queue.
    await appendRunEvent({ kind: 'run.spawned', runId: 'r2', at: '2026-08-18T10:00:00.000Z' });
    expect(await readRunEvents()).toHaveLength(1);
    spy.mockRestore();
  });

  it('redacts the payload before it reaches disk', async () => {
    await appendRunEvent({
      kind: 'run.spawned',
      runId: 'r1',
      at: '2026-08-18T10:00:00.000Z',
      data: { prompt: 'a private task description', model: 'm1' }
    });
    const raw = readFileSync(ACTIVE, 'utf8');
    expect(raw).not.toContain('a private task description');
    expect(raw).toContain('"redacted":"content"');
    expect(raw).toContain('"model":"m1"');
  });
});

describe('duplicate-event idempotency', () => {
  const event = { kind: 'run.finalized', runId: 'r1', agentId: 'a1', at: '2026-08-18T11:00:00.000Z', data: { success: true, exitCode: 0 } };

  it('suppresses a redelivery of the same logical event', async () => {
    const first = await appendRunEvent(event);
    const second = await appendRunEvent({ ...event });
    expect(first).toMatchObject({ appended: true, duplicate: false });
    expect(second).toMatchObject({ appended: false, duplicate: true });
    expect(countLines(ACTIVE)).toBe(1);
  });

  it('still suppresses it across a server restart', async () => {
    // The seen-id set is in memory; a restart must rehydrate it from disk or
    // every boundary that re-fires after a restart doubles.
    await appendRunEvent(event);
    restartServer();
    expect(await appendRunEvent({ ...event })).toMatchObject({ appended: false, duplicate: true });
    expect(countLines(ACTIVE)).toBe(1);
  });

  it('suppresses a redelivery of an event that has aged into the archive', async () => {
    writeFileSync(ARCHIVE, `${JSON.stringify(buildRunEvent(event))}\n`);
    restartServer();
    expect(await appendRunEvent({ ...event })).toMatchObject({ appended: false, duplicate: true });
    expect(countLines(ACTIVE)).toBe(0);
  });

  it('does NOT suppress a genuinely different event at the same boundary', async () => {
    await appendRunEvent(event);
    const other = await appendRunEvent({ ...event, at: '2026-08-18T11:00:01.000Z' });
    expect(other.appended).toBe(true);
    expect(countLines(ACTIVE)).toBe(2);
  });
});

describe('retention / rotation bound', () => {
  it('rotates at MAX_ACTIVE_EVENTS and keeps exactly one archive generation', async () => {
    const seed = (n, offset = 0) => Array.from({ length: n }, (_, i) =>
      `${JSON.stringify(buildRunEvent({ kind: 'run.spawned', runId: `r${offset + i}`, at: '2026-08-18T10:00:00.000Z' }))}\n`).join('');

    // Pre-fill a full active generation and a full archive, then restart so the
    // service counts them off disk the way it would after a reboot.
    writeFileSync(ACTIVE, seed(MAX_ACTIVE_EVENTS));
    writeFileSync(ARCHIVE, seed(MAX_ACTIVE_EVENTS, MAX_ACTIVE_EVENTS));
    restartServer();

    await appendRunEvent({ kind: 'run.spawned', runId: 'fresh', at: '2026-08-18T12:00:00.000Z' });

    // The old archive is gone, the old active IS the archive, and the new event
    // is alone in the new active generation.
    expect(countLines(ACTIVE)).toBe(1);
    expect(countLines(ARCHIVE)).toBe(MAX_ACTIVE_EVENTS);
    const stats = await getRunEventLedgerStats();
    expect(stats.activeEvents + stats.archivedEvents).toBeLessThanOrEqual(stats.maxRetainedEvents);
    expect(stats.maxActiveEvents).toBe(MAX_ACTIVE_EVENTS);
  });

  it('rotates without an existing archive on the very first rollover', async () => {
    writeFileSync(ACTIVE, Array.from({ length: MAX_ACTIVE_EVENTS }, (_, i) =>
      `${JSON.stringify(buildRunEvent({ kind: 'run.spawned', runId: `r${i}`, at: '2026-08-18T10:00:00.000Z' }))}\n`).join(''));
    restartServer();

    await appendRunEvent({ kind: 'run.spawned', runId: 'fresh', at: '2026-08-18T12:00:00.000Z' });
    expect(countLines(ARCHIVE)).toBe(MAX_ACTIVE_EVENTS);
    expect(countLines(ACTIVE)).toBe(1);
  });
});

describe('readRunEvents', () => {
  beforeEach(async () => {
    await appendRunEvent({ kind: 'run.spawned', runId: 'r1', agentId: 'a1', taskId: 't1', at: '2026-08-18T10:00:00.000Z' });
    await appendRunEvent({ kind: 'run.spawned', runId: 'r2', agentId: 'a2', taskId: 't2', at: '2026-08-18T10:05:00.000Z' });
    await appendRunEvent({ kind: 'run.finalized', runId: 'r1', agentId: 'a1', at: '2026-08-18T10:10:00.000Z', data: { success: true } });
  });

  it('reads an absent ledger as empty rather than failing', async () => {
    resetLedger();
    expect(await readRunEvents()).toEqual([]);
    expect(await getRunProjections()).toEqual([]);
  });

  it('filters by run, agent, task, and kind', async () => {
    expect(await readRunEvents({ runId: 'r1' })).toHaveLength(2);
    expect(await readRunEvents({ agentId: 'a2' })).toHaveLength(1);
    expect(await readRunEvents({ taskId: 't2' })).toHaveLength(1);
    expect(await readRunEvents({ kind: 'run.finalized' })).toHaveLength(1);
    expect(await readRunEvents({ since: '2026-08-18T10:04:00.000Z' })).toHaveLength(2);
  });

  it('keeps the NEWEST events when a limit truncates', async () => {
    const events = await readRunEvents({ limit: 1 });
    expect(events.map((e) => e.kind)).toEqual(['run.finalized']);
  });

  it('reads the archive generation before the active one, preserving append order', async () => {
    const all = await readRunEvents();
    writeFileSync(ARCHIVE, readFileSync(ACTIVE, 'utf8'));
    writeFileSync(ACTIVE, '');
    restartServer();
    expect((await readRunEvents()).map((e) => e.eventId)).toEqual(all.map((e) => e.eventId));
  });

  it('keeps a line whose KIND this build does not know', async () => {
    // A newer install's ledger (or this one's, before a downgrade) must still
    // read here — dropping unknown kinds would lose the trace and renumber
    // eventCount, which the projection's unknown-kind tolerance already avoids.
    const known = await readRunEvents({ runId: 'r1' });
    const future = { ...known[0], eventId: 'future-1', kind: 'run.from-the-future', at: '2026-08-18T10:20:00.000Z' };
    writeFileSync(ACTIVE, `${readFileSync(ACTIVE, 'utf8')}${JSON.stringify(future)}\n`);
    restartServer();

    expect((await readRunEvents()).map((e) => e.kind)).toContain('run.from-the-future');
    const [state] = await getRunProjections({ runId: 'r1' });
    expect(state.eventCount).toBe(3);
    expect(state.status).toBe('completed'); // unknown kind counted, not interpreted
  });

  it('drops a corrupt line instead of poisoning the whole read', async () => {
    writeFileSync(ACTIVE, `${readFileSync(ACTIVE, 'utf8')}{"eventId":"x","kind":"nope"}\nnot json at all\n`);
    restartServer();
    const events = await readRunEvents();
    expect(events).toHaveLength(3);
    expect(events.every((e) => e.schemaVersion === 1)).toBe(true);
  });
});

describe('replay / projections', () => {
  it('derives current run status from the stream after a restart', async () => {
    await appendRunEvent({ kind: 'run.spawned', runId: 'r1', agentId: 'a1', taskId: 't1', at: '2026-08-18T10:00:00.000Z', data: { model: 'm1' } });
    await appendRunEvent({ kind: 'run.runner-recovered', runId: 'r1', agentId: 'a1', at: '2026-08-18T10:30:00.000Z' });
    await appendRunEvent({ kind: 'run.finalized', runId: 'r1', agentId: 'a1', at: '2026-08-18T11:00:00.000Z', data: { success: false, exitCode: 1, errorCategory: 'orphaned' } });
    await flushRunEvents();

    restartServer();

    const [state] = await getRunProjections();
    expect(state).toMatchObject({
      id: 'r1',
      status: 'failed',
      success: false,
      exitCode: 1,
      errorCategory: 'orphaned',
      recoveryCount: 1,
      eventCount: 3
    });
  });

  it('scopes projections to one run when asked', async () => {
    await appendRunEvent({ kind: 'run.spawned', runId: 'r1', at: '2026-08-18T10:00:00.000Z' });
    await appendRunEvent({ kind: 'run.spawned', runId: 'r2', at: '2026-08-18T10:01:00.000Z' });
    const states = await getRunProjections({ runId: 'r2' });
    expect(states.map((s) => s.id)).toEqual(['r2']);
  });

  it('getRunDiagnostic returns one run projection plus the events behind it', async () => {
    await appendRunEvent({ kind: 'run.spawned', runId: 'r1', agentId: 'a1', at: '2026-08-18T10:00:00.000Z' });
    await appendRunEvent({ kind: 'run.orphan-recovered', runId: 'r1', agentId: 'a1', at: '2026-08-18T10:05:00.000Z' });
    await appendRunEvent({ kind: 'run.spawned', runId: 'r2', at: '2026-08-18T10:06:00.000Z' });

    const { projection, events } = await getRunDiagnostic('r1');
    expect(projection.status).toBe('orphaned');
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.runId === 'r1')).toBe(true);
  });

  it('getRunDiagnostic resolves the agent fallback key for a run that never got an id', async () => {
    await appendRunEvent({ kind: 'run.orphan-recovered', agentId: 'a9', taskId: 't9', at: '2026-08-18T10:00:00.000Z', data: { hasRunId: false } });
    // An id-bearing event for the same agent belongs to the run, not the fallback bucket.
    await appendRunEvent({ kind: 'run.spawned', runId: 'r9', agentId: 'a9', at: '2026-08-18T10:01:00.000Z' });

    const { projection, events } = await getRunDiagnostic('agent:a9');
    expect(projection.id).toBe('agent:a9');
    expect(projection.status).toBe('orphaned');
    expect(events).toHaveLength(1);
  });

  it('reports an unknown id as no projection rather than throwing', async () => {
    expect(await getRunDiagnostic('nope')).toEqual({ projection: null, events: [] });
  });
});
