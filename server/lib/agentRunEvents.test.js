import { describe, it, expect } from 'vitest';
import { homedir } from 'os';
import {
  AGENT_RUN_EVENT_KINDS,
  AGENT_RUN_EVENT_SCHEMA_VERSION,
  RUN_EVENT_LIMITS,
  agentRunEventSchema,
  buildRunEvent,
  isKnownRunEventKind,
  isValidRunEvent,
  projectRunState,
  projectRunStates,
  redactRunEventData,
  isStoredRunEvent,
  runEventKey,
  scrubHomePath
} from './agentRunEvents.js';

const AT = '2026-08-18T12:00:00.000Z';

describe('buildRunEvent — envelope schema', () => {
  it('produces an envelope the schema accepts', () => {
    const event = buildRunEvent({ kind: 'run.spawned', runId: 'r1', agentId: 'a1', taskId: 't1', at: AT });
    expect(agentRunEventSchema.safeParse(event).success).toBe(true);
    expect(event.schemaVersion).toBe(AGENT_RUN_EVENT_SCHEMA_VERSION);
    expect(event.at).toBe(AT);
    expect(event.data).toEqual({});
  });

  it('rejects a kind outside the closed vocabulary', () => {
    expect(() => buildRunEvent({ kind: 'run.invented', runId: 'r1', at: AT })).toThrow();
  });

  it('normalizes absent / blank ids to null rather than empty strings', () => {
    const event = buildRunEvent({ kind: 'run.spawned', runId: 'r1', agentId: '   ', at: AT });
    expect(event.agentId).toBeNull();
    expect(event.taskId).toBeNull();
  });

  it('accepts a Date for `at` and normalizes it to ISO', () => {
    const event = buildRunEvent({ kind: 'run.spawned', runId: 'r1', at: new Date(AT) });
    expect(event.at).toBe(AT);
  });

  it('isValidRunEvent rejects a line missing required fields', () => {
    expect(isValidRunEvent({ kind: 'run.spawned' })).toBe(false);
    expect(isValidRunEvent(buildRunEvent({ kind: 'run.spawned', runId: 'r1', at: AT }))).toBe(true);
  });

  it('admits an UNKNOWN kind on the read path while refusing it on the write path', () => {
    // A ledger file outlives the build that wrote it. Validating reads against
    // the closed enum would drop a newer install's lines, losing the trace AND
    // renumbering eventCount — the projection already folds unknown kinds as
    // no-ops, so the read check only has to be structural.
    const future = { ...buildRunEvent({ kind: 'run.spawned', runId: 'r1', at: AT }), kind: 'run.from-the-future' };
    expect(isStoredRunEvent(future)).toBe(true);
    expect(isValidRunEvent(future)).toBe(false);
  });

  it('still refuses a structurally broken line on the read path', () => {
    expect(isStoredRunEvent({ kind: 'run.spawned' })).toBe(false);
    expect(isStoredRunEvent({ ...buildRunEvent({ kind: 'run.spawned', runId: 'r1', at: AT }), at: 'not-a-date' })).toBe(false);
    expect(isStoredRunEvent({ ...buildRunEvent({ kind: 'run.spawned', runId: 'r1', at: AT }), extra: 1 })).toBe(false);
  });

  it('isKnownRunEventKind tracks the exported vocabulary', () => {
    for (const kind of AGENT_RUN_EVENT_KINDS) expect(isKnownRunEventKind(kind)).toBe(true);
    expect(isKnownRunEventKind('run.nope')).toBe(false);
  });
});

describe('buildRunEvent — idempotent event ids', () => {
  const base = { kind: 'run.finalized', runId: 'r1', agentId: 'a1', taskId: 't1', at: AT, data: { success: true, exitCode: 0 } };

  it('derives the SAME id for a redelivery of the same logical event', () => {
    // The whole point: a lifecycle boundary that fires twice (retried orphan
    // sweep, duplicated runner completion) must not become two facts.
    expect(buildRunEvent(base).eventId).toBe(buildRunEvent({ ...base }).eventId);
  });

  it('derives the same id regardless of the order the data keys were written', () => {
    const a = buildRunEvent({ ...base, data: { success: true, exitCode: 0 } });
    const b = buildRunEvent({ ...base, data: { exitCode: 0, success: true } });
    expect(a.eventId).toBe(b.eventId);
  });

  it('derives a DIFFERENT id when any envelope field differs', () => {
    const id = buildRunEvent(base).eventId;
    expect(buildRunEvent({ ...base, at: '2026-08-18T12:00:01.000Z' }).eventId).not.toBe(id);
    expect(buildRunEvent({ ...base, runId: 'r2' }).eventId).not.toBe(id);
    expect(buildRunEvent({ ...base, kind: 'run.orphan-recovered' }).eventId).not.toBe(id);
    expect(buildRunEvent({ ...base, data: { success: false, exitCode: 1 } }).eventId).not.toBe(id);
  });

  it('honors an explicit idempotency key when a caller has a better one', () => {
    expect(buildRunEvent({ ...base, eventId: 'natural-key-1' }).eventId).toBe('natural-key-1');
  });
});

describe('redactRunEventData — privacy', () => {
  it('drops prompt / description / output / result content to a size stub', () => {
    const data = redactRunEventData({
      prompt: 'ship the feature and mention Jane Doe',
      taskDescription: 'rename the Example Universe series',
      output: 'a very long transcript',
      result: { body: 'nested record contents' },
      params: ['secret', 'values'],
      model: 'some-model'
    });
    expect(data.prompt).toEqual({ redacted: 'content', chars: 'ship the feature and mention Jane Doe'.length });
    expect(data.taskDescription).toEqual({ redacted: 'content', chars: 'rename the Example Universe series'.length });
    expect(data.output.redacted).toBe('content');
    expect(data.result).toEqual({ redacted: 'content', chars: null });
    expect(data.params).toEqual({ redacted: 'content', chars: null });
    // Non-content metadata is exactly what a diagnostic needs, so it survives.
    expect(data.model).toBe('some-model');
    expect(JSON.stringify(data)).not.toContain('Jane Doe');
    expect(JSON.stringify(data)).not.toContain('Example Universe');
  });

  it('keeps a NUMBER under a dropped key — a size is not content', () => {
    // The size is the only part of a prompt that was already safe; stubbing it
    // out would delete the diagnostic and protect nothing.
    expect(redactRunEventData({ promptChars: 4096 })).toEqual({ promptChars: 4096 });
  });

  it('scrubs the home-directory prefix out of every remaining string', () => {
    const workspacePath = `${homedir()}/github.com/example/app`;
    const data = redactRunEventData({ workspacePath });
    expect(data.workspacePath).toBe('~/github.com/example/app');
    expect(data.workspacePath).not.toContain(homedir());
  });

  it('scrubHomePath replaces every occurrence, not just a leading one', () => {
    const home = homedir();
    expect(scrubHomePath(`from ${home}/a to ${home}/b`)).toBe('from ~/a to ~/b');
    expect(scrubHomePath(42)).toBe(42);
  });

  it('redacts sensitive env values via the shared secret filter', () => {
    const data = redactRunEventData({ detail: '{"API_KEY": "sk-live-abc123"}' });
    expect(data.detail).not.toContain('sk-live-abc123');
    expect(data.detail).toContain('[REDACTED]');
  });

  it('caps string length so a payload cannot smuggle a record body', () => {
    const data = redactRunEventData({ detail: 'x'.repeat(5000) });
    expect(data.detail.length).toBe(RUN_EVENT_LIMITS.maxStringChars + 1); // + the ellipsis
  });

  it('caps array length, key count, and nesting depth', () => {
    const wide = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    const capped = redactRunEventData(wide);
    expect(Object.keys(capped).length).toBeLessThanOrEqual(RUN_EVENT_LIMITS.maxObjectKeys + 1);
    expect(capped.redacted).toBe('keys');

    const long = redactRunEventData({ items: Array.from({ length: 100 }, (_, i) => i) });
    expect(long.items.length).toBe(RUN_EVENT_LIMITS.maxArrayItems + 1);
    expect(long.items.at(-1)).toEqual({ redacted: 'truncated', dropped: 80 });

    const deep = redactRunEventData({ a: { b: { c: { d: { e: 'too deep' } } } } });
    expect(JSON.stringify(deep)).toContain('"redacted":"depth"');
    expect(JSON.stringify(deep)).not.toContain('too deep');
  });

  it('strips prototype-polluting keys and non-JSON values', () => {
    const data = redactRunEventData(JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}'));
    expect(Object.hasOwn(data, '__proto__')).toBe(false);
    expect({}.polluted).toBeUndefined();
    expect(redactRunEventData({ fn: () => 1, sym: Symbol('s'), gone: undefined, kept: true }))
      .toEqual({ kept: true });
  });

  it('boxes a scalar or array payload so the envelope stays a record', () => {
    expect(redactRunEventData('hello')).toEqual({ value: 'hello' });
    expect(redactRunEventData([1, 2])).toEqual({ items: [1, 2] });
    expect(redactRunEventData(null)).toEqual({});
  });

  it('redacts inside buildRunEvent, so an unredacted payload cannot be constructed', () => {
    const event = buildRunEvent({ kind: 'run.spawned', runId: 'r1', at: AT, data: { prompt: 'private words' } });
    expect(event.data.prompt).toEqual({ redacted: 'content', chars: 13 });
  });
});

describe('projectRunStates — replayable status', () => {
  const stream = [
    buildRunEvent({ kind: 'run.spawned', runId: 'r1', agentId: 'a1', taskId: 't1', at: '2026-08-18T10:00:00.000Z', data: { providerId: 'p1', model: 'm1' } }),
    buildRunEvent({ kind: 'run.runner-recovered', runId: 'r1', agentId: 'a1', at: '2026-08-18T10:30:00.000Z' }),
    buildRunEvent({ kind: 'run.finalized', runId: 'r1', agentId: 'a1', at: '2026-08-18T11:00:00.000Z', data: { success: true, exitCode: 0, durationMs: 3600000 } })
  ];

  it('folds a full lifecycle into a completed run', () => {
    const [state] = projectRunStates(stream);
    expect(state).toMatchObject({
      id: 'r1',
      runId: 'r1',
      agentId: 'a1',
      taskId: 't1',
      status: 'completed',
      success: true,
      exitCode: 0,
      durationMs: 3600000,
      recoveryCount: 1,
      eventCount: 3,
      startedAt: '2026-08-18T10:00:00.000Z',
      endedAt: '2026-08-18T11:00:00.000Z'
    });
    expect(state.trace.map((t) => t.kind)).toEqual(['run.spawned', 'run.runner-recovered', 'run.finalized']);
  });

  it('is pure — replaying the same stream twice yields the same state', () => {
    // This is what makes "rebuild after a restart" and "read current status"
    // one code path: no clock, no I/O, no accumulated module state.
    expect(projectRunStates(stream)).toEqual(projectRunStates(stream));
  });

  it('reports a still-open run as running', () => {
    const [state] = projectRunStates([stream[0]]);
    expect(state.status).toBe('running');
    expect(state.endedAt).toBeNull();
    expect(state.success).toBeNull();
  });

  it('lets a later finalize outrank an earlier orphan recovery', () => {
    // Orphan cleanup emits BOTH, in this order — the terminal verdict must win.
    const [state] = projectRunStates([
      stream[0],
      buildRunEvent({ kind: 'run.orphan-recovered', runId: 'r1', at: '2026-08-18T10:45:00.000Z', data: { interruptedByRestart: true } }),
      buildRunEvent({ kind: 'run.finalized', runId: 'r1', at: '2026-08-18T10:46:00.000Z', data: { success: false, exitCode: 143, errorCategory: 'interrupted' } })
    ]);
    expect(state.status).toBe('failed');
    expect(state.orphaned).toBe(true);
    expect(state.errorCategory).toBe('interrupted');
  });

  it('leaves an orphan that was never finalized in the orphaned state', () => {
    const [state] = projectRunStates([
      stream[0],
      buildRunEvent({ kind: 'run.orphan-recovered', runId: 'r1', at: '2026-08-18T10:45:00.000Z' })
    ]);
    expect(state.status).toBe('orphaned');
  });

  it('keeps a run that never got an id, keyed by its agent', () => {
    // The un-idded orphan is exactly the failure this ledger exists to explain,
    // so it must not be the case the projection silently drops.
    const [state] = projectRunStates([
      buildRunEvent({ kind: 'run.orphan-recovered', agentId: 'a9', taskId: 't9', at: AT, data: { hasRunId: false } })
    ]);
    expect(state.id).toBe('agent:a9');
    expect(state.runId).toBeNull();
    expect(state.status).toBe('orphaned');
    expect(runEventKey({ agentId: 'a9' })).toBe('agent:a9');
    expect(runEventKey({})).toBeNull();
  });

  it('carries ids forward when a later event omits them', () => {
    const [state] = projectRunStates([
      stream[0],
      buildRunEvent({ kind: 'run.finalized', runId: 'r1', at: AT, data: { success: true } })
    ]);
    expect(state.taskId).toBe('t1');
    expect(state.agentId).toBe('a1');
  });

  it('counts an unknown kind without letting it change status', () => {
    // A ledger written by a newer install must still replay on an older one.
    const [state] = projectRunStates([stream[0], { ...stream[1], kind: 'run.from-the-future' }]);
    expect(state.status).toBe('running');
    expect(state.eventCount).toBe(2);
  });

  it('separates runs and orders them by most recent activity', () => {
    const states = projectRunStates([
      buildRunEvent({ kind: 'run.spawned', runId: 'old', at: '2026-08-18T09:00:00.000Z' }),
      buildRunEvent({ kind: 'run.spawned', runId: 'new', at: '2026-08-18T13:00:00.000Z' })
    ]);
    expect(states.map((s) => s.id)).toEqual(['new', 'old']);
  });

  it('tolerates a non-array input', () => {
    expect(projectRunStates(null)).toEqual([]);
    expect(projectRunState(stream, 'nope')).toBeNull();
    expect(projectRunState(stream, 'r1').status).toBe('completed');
  });
});
