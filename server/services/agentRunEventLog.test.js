import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
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
  appendMindEvent,
  readRunEvents,
  readPersistentMindEvents,
  readPersistentMindHistory,
  getRunProjections,
  getRunDiagnostic,
  getRunEventLedgerStats,
  flushRunEvents,
  __resetRunEventLogCache,
  MAX_ACTIVE_EVENTS,
  MAX_ACTIVE_MIND_EVENTS,
  MAX_EVENT_AGE_DAYS
} = await import('./agentRunEventLog.js');
const { buildRunEvent } = await import('../lib/agentRunEvents.js');
const { persistentMindEventCursor } = await import('../lib/persistentMindTrajectory.js');

const ACTIVE = join(LEDGER_DIR, 'run-events.jsonl');
const ARCHIVE = join(LEDGER_DIR, 'run-events.1.jsonl');
const MIND_ACTIVE = join(LEDGER_DIR, 'mind-events.jsonl');
const MIND_ARCHIVE = join(LEDGER_DIR, 'mind-events.1.jsonl');
const MIND_SEQUENCES = join(LEDGER_DIR, 'persistent-mind-sequences.json');

/** Wipe the on-disk ledger AND the in-process caches — i.e. a fresh install. */
function resetLedger() {
  for (const path of [ACTIVE, ARCHIVE, MIND_ACTIVE, MIND_ARCHIVE, MIND_SEQUENCES]) if (existsSync(path)) rmSync(path);
  __resetRunEventLogCache();
}

/** Drop only the in-process caches — i.e. a server restart over the same disk. */
const restartServer = () => __resetRunEventLogCache();

const countLines = (path) => (existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter(Boolean).length : 0);

beforeEach(resetLedger);

// Pin the clock next to the fixture timestamps below. The ledger's AGE bound is
// measured against the wall clock, so with a real clock every assertion in this
// file would silently start failing MAX_EVENT_AGE_DAYS after the fixture date —
// a red suite triggered by the calendar with no code change behind it. Only
// `Date` is faked: the service does real fs I/O, and faking timers would stall it.
const NOW = '2026-08-18T13:00:00.000Z';
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

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

describe('persistent-mind ordering, replay, and cursors', () => {
  const appendMessage = (id) => appendMindEvent({
    kind: 'mind.message.accepted',
    eventId: `mind-message:${id}`,
    data: { messageId: id, displayText: `Message ${id}` },
  });

  it('serializes concurrent appends into strict per-mind sequence order', async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => appendMessage(index)));
    const events = await readPersistentMindHistory();

    expect(results.every((result) => result.appended)).toBe(true);
    expect(events.map((event) => event.data.messageId)).toEqual(Array.from({ length: 20 }, (_, index) => index));
    expect(events.every((event, index) => index === 0 || event.sequence > events[index - 1].sequence)).toBe(true);
  });

  it('keeps predecessor provenance when a capability payload fills the key budget', async () => {
    const data = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`k${index}`, index]));
    const result = await appendMindEvent({
      kind: 'mind.capability.request',
      eventId: 'mind-capability:wide',
      data,
    });

    expect(result.event.data.previousSequence).toBeNull();
    expect(result.event.data.k39).toBe(39);
  });

  it('deduplicates an explicit event id without consuming another sequence', async () => {
    const first = await appendMessage('one');
    const duplicate = await appendMessage('one');
    const second = await appendMessage('two');

    expect(duplicate).toMatchObject({ appended: false, duplicate: true });
    expect(await readPersistentMindHistory()).toHaveLength(2);
    expect(second.event.sequence).toBe(first.event.sequence + 1);
  });

  it('continues sequence order and reconstructs the same snapshot after restart', async () => {
    await appendMessage('one');
    await appendMindEvent({
      kind: 'mind.wake',
      turnId: 'turn-1',
      eventId: 'mind-wake:turn-1',
    });
    const before = await readPersistentMindEvents();

    restartServer();
    const after = await readPersistentMindEvents();
    const completed = await appendMindEvent({
      kind: 'mind.turn.completed',
      turnId: 'turn-1',
      eventId: 'mind-complete:turn-1',
    });

    expect(after.snapshot).toEqual(before.snapshot);
    expect(completed.event.sequence).toBeGreaterThan(after.snapshot.lastSequence);
  });

  it('keeps sequence order after all raw events expire and the wall clock moves backwards', async () => {
    const first = await appendMessage('one');
    writeFileSync(MIND_ACTIVE, '');
    restartServer();
    vi.setSystemTime(new Date('2026-08-17T13:00:00.000Z'));

    const later = await appendMessage('two');
    expect(later.event.sequence).toBe(first.event.sequence + 1);
  });

  it('fails mind appends closed on a corrupt sequence checkpoint without blocking ordinary run events', async () => {
    writeFileSync(MIND_SEQUENCES, '{broken');
    restartServer();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(appendMessage('one')).resolves.toMatchObject({
      appended: false,
      error: 'Persistent mind sequence checkpoint is unreadable or invalid',
    });
    await expect(appendRunEvent({
      kind: 'run.spawned',
      runId: 'ordinary-run',
      at: '2026-08-18T12:00:00.000Z',
    })).resolves.toMatchObject({ appended: true });
    expect((await readRunEvents()).map((item) => item.runId)).toEqual(['ordinary-run']);
    spy.mockRestore();
  });

  it('pages strictly after a cursor and reports a missing retained predecessor as a gap', async () => {
    await appendMessage('one');
    await appendMessage('two');
    await appendMessage('three');
    const history = await readPersistentMindHistory();
    const cursor = persistentMindEventCursor(history[0]);

    const page = await readPersistentMindEvents({ cursor, limit: 1 });
    expect(page).toMatchObject({ gap: false, hasMore: true });
    expect(page.events.map((item) => item.data.messageId)).toEqual(['two']);
    expect(page.cursor).toBe(persistentMindEventCursor(history[1]));

    writeFileSync(MIND_ACTIVE, history.slice(1).map((item) => `${JSON.stringify(item)}\n`).join(''));
    restartServer();
    const recovered = await readPersistentMindEvents({ cursor, limit: 2 });
    expect(recovered.gap).toBe(true);
    expect(recovered.events.map((item) => item.data.messageId)).toEqual(['two', 'three']);
    expect(recovered.snapshot.messages.map((item) => item.messageId)).toEqual(['two', 'three']);
  });

  it('marks a cursorless bounded tail as truncated', async () => {
    await appendMessage('one');
    await appendMessage('two');
    await appendMessage('three');

    const page = await readPersistentMindEvents({ limit: 2 });
    expect(page).toMatchObject({ gap: false, hasMore: false, truncated: true });
    expect(page.events.map((item) => item.data.messageId)).toEqual(['two', 'three']);
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

  it('keeps persistent-mind chatter in its own larger rotation pool', async () => {
    const mindSeed = Array.from({ length: MAX_ACTIVE_MIND_EVENTS }, (_, index) => `${JSON.stringify(buildRunEvent({
      kind: 'mind.wake',
      mindId: 'cos-persistent-mind',
      sequence: index + 1,
      eventId: `mind-${index}`,
      at: '2026-08-18T10:00:00.000Z',
      data: { previousSequence: index || null },
    }))}\n`).join('');
    writeFileSync(MIND_ACTIVE, mindSeed);
    await appendRunEvent({ kind: 'run.spawned', runId: 'ordinary', at: '2026-08-18T12:00:00.000Z' });
    restartServer();
    await appendMindEvent({ kind: 'mind.wake', eventId: 'mind-fresh' });

    expect(countLines(ACTIVE)).toBe(1);
    expect(countLines(ARCHIVE)).toBe(0);
    expect(countLines(MIND_ACTIVE)).toBe(1);
    expect(countLines(MIND_ARCHIVE)).toBe(MAX_ACTIVE_MIND_EVENTS);
    const stats = await getRunEventLedgerStats();
    expect(stats.maxRetainedMindEvents).toBe(MAX_ACTIVE_MIND_EVENTS * 2);
  });

  it('does not let a full mind page crowd ordinary run diagnostics out of their read cap', async () => {
    const ordinary = buildRunEvent({ kind: 'run.spawned', runId: 'ordinary', at: '2026-08-18T10:00:00.000Z' });
    const minds = Array.from({ length: 1001 }, (_, index) => buildRunEvent({
      kind: 'mind.wake',
      mindId: 'cos-persistent-mind',
      sequence: index + 1,
      eventId: `mind-page-${index}`,
      at: '2026-08-18T10:00:00.000Z',
      data: { previousSequence: index || null },
    }));
    writeFileSync(ACTIVE, `${JSON.stringify(ordinary)}\n`);
    writeFileSync(MIND_ACTIVE, minds.map((event) => `${JSON.stringify(event)}\n`).join(''));
    restartServer();

    expect((await readRunEvents()).map((event) => event.runId)).toEqual(['ordinary']);
    expect((await getRunProjections()).map((state) => state.id)).toEqual(['ordinary']);
  });

  it('re-homes rollback-era mind events without counting them as ordinary diagnostics', async () => {
    const ordinary = buildRunEvent({ kind: 'run.spawned', runId: 'ordinary', at: '2026-08-18T10:00:00.000Z' });
    const legacyMind = buildRunEvent({
      kind: 'mind.wake',
      mindId: 'cos-persistent-mind',
      sequence: 10,
      eventId: 'legacy-mind',
      at: '2026-08-18T10:00:01.000Z',
    });
    writeFileSync(ACTIVE, `${JSON.stringify(ordinary)}\n${JSON.stringify(legacyMind)}\n`);
    restartServer();

    expect(await getRunEventLedgerStats()).toMatchObject({
      archivedEvents: 0,
      activeEvents: 1,
      mindArchivedEvents: 0,
      mindActiveEvents: 1,
    });
    expect((await readRunEvents()).map((event) => event.runId)).toEqual(['ordinary']);
    expect((await readPersistentMindHistory()).map((event) => event.eventId)).toEqual(['legacy-mind']);
    expect(countLines(ACTIVE)).toBe(1);
    expect(countLines(MIND_ACTIVE)).toBe(1);
  });

  it('preserves structurally valid future kinds from the physical mind ledger', async () => {
    const future = {
      ...buildRunEvent({
        kind: 'mind.wake',
        mindId: 'cos-persistent-mind',
        sequence: 1,
        eventId: 'future-mind-kind',
        at: '2026-08-18T10:00:00.000Z',
      }),
      kind: 'mind.future-boundary',
    };
    writeFileSync(MIND_ACTIVE, `${JSON.stringify(future)}\n`);
    restartServer();

    expect((await readPersistentMindHistory()).map((event) => event.kind)).toEqual(['mind.future-boundary']);
    expect((await getRunEventLedgerStats()).mindActiveEvents).toBe(1);
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

describe('retention — age bound (#4540)', () => {
  /** An ISO timestamp `days` before the pinned NOW. */
  const daysAgo = (days) => new Date(Date.parse(NOW) - days * 24 * 60 * 60 * 1000).toISOString();
  const stale = () => daysAgo(MAX_EVENT_AGE_DAYS + 1);
  const recent = () => daysAgo(1);

  const seedLines = (events) => events.map((e) => `${JSON.stringify(buildRunEvent(e))}\n`).join('');

  it('hides an expired event from every read, and sweeps it off disk', async () => {
    writeFileSync(ACTIVE, seedLines([
      { kind: 'run.spawned', runId: 'ancient', at: stale() },
      { kind: 'run.spawned', runId: 'current', at: recent() }
    ]));
    restartServer();

    const events = await readRunEvents();
    expect(events.map((e) => e.runId)).toEqual(['current']);
    // …and the file itself shrank, so a quiet install's ledger doesn't grow
    // forever under a count bound it never reaches.
    expect(countLines(ACTIVE)).toBe(1);
  });

  it('keeps the mind recent window count-bounded across a long explicit stop', async () => {
    const mindEvent = buildRunEvent({
      kind: 'mind.message.accepted',
      mindId: 'cos-persistent-mind',
      sequence: 1,
      eventId: 'mind-message:ancient',
      at: stale(),
      data: { messageId: 'ancient', displayText: 'Retain until it can be summarized.' },
    });
    writeFileSync(MIND_ACTIVE, `${JSON.stringify(mindEvent)}\n`);
    restartServer();

    expect((await readPersistentMindHistory()).map((item) => item.eventId)).toEqual(['mind-message:ancient']);
    expect(countLines(MIND_ACTIVE)).toBe(1);
    expect(await appendMindEvent({
      kind: 'mind.message.accepted',
      eventId: 'mind-message:ancient',
      at: stale(),
      data: { messageId: 'ancient', displayText: 'Retain until it can be summarized.' },
    })).toMatchObject({ appended: false, duplicate: true });
  });

  it('drops an archive generation that has aged out entirely', async () => {
    writeFileSync(ARCHIVE, seedLines([{ kind: 'run.spawned', runId: 'ancient', at: stale() }]));
    writeFileSync(ACTIVE, seedLines([{ kind: 'run.spawned', runId: 'current', at: recent() }]));
    restartServer();

    const stats = await getRunEventLedgerStats();
    expect(stats).toMatchObject({ archivedEvents: 0, activeEvents: 1, maxEventAgeDays: MAX_EVENT_AGE_DAYS });
    expect(stats.oldestEventAt).toBe(recent());
    // An emptied archive is unlinked, not rewritten as a zero-byte file.
    expect(existsSync(ARCHIVE)).toBe(false);
  });

  it('re-admits an event whose only copy aged out', async () => {
    // Same reasoning as rotation: a duplicate we can no longer see is no longer
    // a duplicate. If expiry dropped the line but kept the id, the run could
    // never be re-observed.
    const event = { kind: 'run.spawned', runId: 'r1', agentId: 'a1', at: stale() };
    writeFileSync(ACTIVE, seedLines([event]));
    restartServer();

    expect(await appendRunEvent(event)).toMatchObject({ appended: true, duplicate: false });
    expect(countLines(ACTIVE)).toBe(1);
  });

  it('keeps deduping an event that is still inside the age window', async () => {
    const event = { kind: 'run.spawned', runId: 'r1', agentId: 'a1', at: recent() };
    await appendRunEvent(event);
    expect(await appendRunEvent({ ...event })).toMatchObject({ appended: false, duplicate: true });
  });

  it('leaves a fresh ledger completely untouched', async () => {
    await appendRunEvent({ kind: 'run.spawned', runId: 'r1', at: recent() });
    await appendRunEvent({ kind: 'run.finalized', runId: 'r1', at: recent(), data: { success: true } });
    const before = readFileSync(ACTIVE, 'utf8');
    restartServer();
    await readRunEvents();
    expect(readFileSync(ACTIVE, 'utf8')).toBe(before);
  });

  it('sweeps an undatable corrupt line that no read could ever return', async () => {
    writeFileSync(ACTIVE, `${seedLines([{ kind: 'run.spawned', runId: 'r1', at: recent() }])}{"eventId":"x","kind":"run.spawned"}\n`);
    restartServer();
    await readRunEvents();
    expect(countLines(ACTIVE)).toBe(1);
  });
});

describe('retention — dedupe and the age bound agree (#4540)', () => {
  const MINUTE = 60 * 1000;
  const AGE_MS = MAX_EVENT_AGE_DAYS * 24 * 60 * MINUTE;

  it('re-admits an expired event even when the on-disk prune has not run yet', async () => {
    // The prune is throttled to once an hour; the read filter is not. Without an
    // age-aware duplicate check there is a window where a redelivery is rejected
    // as a duplicate of an event no reader can see — the ledger would hold a
    // fact it refuses to show and refuses to re-record.
    //
    // Pinned INSIDE that window on purpose: the event is 30 minutes short of
    // expiry when first appended, and the clock then advances 40 minutes — past
    // the event's age bound, but short of the prune interval that would
    // otherwise have swept the id away and made this pass for the wrong reason.
    const event = { kind: 'run.spawned', runId: 'r1', at: new Date(Date.parse(NOW) - AGE_MS + 30 * MINUTE).toISOString() };
    expect(await appendRunEvent(event)).toMatchObject({ appended: true });

    vi.setSystemTime(new Date(Date.parse(NOW) + 40 * MINUTE));
    expect(countLines(ACTIVE)).toBe(1); // still on disk — the prune has NOT run
    expect(await readRunEvents()).toHaveLength(0); // …but no reader can see it

    expect(await appendRunEvent({ ...event })).toMatchObject({ appended: true, duplicate: false });
  });
});

describe('retention — one predicate for reads, stats, and the prune (#4540)', () => {
  it('does not count a corrupt line the read path refuses to return', async () => {
    // Otherwise "stats say 2 events" and "the events endpoint returns 1"
    // disagree, and the stats are the thing a reader consults to decide whether
    // a missing run aged out or was never recorded.
    await appendRunEvent({ kind: 'run.spawned', runId: 'r1', at: '2026-08-18T12:00:00.000Z' });
    writeFileSync(ACTIVE, `${readFileSync(ACTIVE, 'utf8')}{"eventId":"x","kind":"run.spawned","at":"2026-08-18T12:30:00.000Z"}\n`);
    restartServer();

    const stats = await getRunEventLedgerStats();
    expect(stats.activeEvents).toBe(1);
    expect(await readRunEvents()).toHaveLength(1);
  });
});
