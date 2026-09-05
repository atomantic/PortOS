import { describe, expect, it } from 'vitest';
import {
  PERSISTENT_MIND_ID,
  assemblePersistentMindContext,
  buildPersistentMindRollup,
  parsePersistentMindCursor,
  persistentMindEventCursor,
  projectPersistentMind,
  buildPersistentMindCallReceipt,
  normalizePersistentMindCallUsage,
  publicPersistentMindCallReceipt,
  publicPersistentMindTurnExecutions,
} from './persistentMindTrajectory.js';

const event = ({
  eventId,
  sequence,
  kind,
  turnId = null,
  text = null,
  at = `2026-08-25T12:00:${String(sequence).padStart(2, '0')}.000Z`,
  data = {},
}) => ({
  schemaVersion: 1,
  eventId,
  kind,
  runId: null,
  agentId: null,
  taskId: null,
  mindId: PERSISTENT_MIND_ID,
  turnId,
  sequence,
  at,
  data: text === null ? data : { ...data, displayText: text },
});

const source = (events) => ({
  fromSequence: events[0].sequence,
  toSequence: events.at(-1).sequence,
  fromEventId: events[0].eventId,
  toEventId: events.at(-1).eventId,
});

describe('persistent mind cursors', () => {
  it('round-trips a durable sequence and event id', () => {
    const cursor = persistentMindEventCursor({ sequence: 42, eventId: 'event-42' });
    expect(cursor).toBe('42:event-42');
    expect(parsePersistentMindCursor(cursor)).toEqual({ sequence: 42, eventId: 'event-42' });
  });

  it('rejects malformed or unsafe cursors instead of treating them as empty history', () => {
    expect(parsePersistentMindCursor('not-a-cursor')).toBeNull();
    expect(parsePersistentMindCursor('-1:event')).toBeNull();
    expect(parsePersistentMindCursor(`${Number.MAX_SAFE_INTEGER}0:event`)).toBeNull();
  });
});

describe('projectPersistentMind', () => {
  const stream = [
    event({ eventId: 'message-1', sequence: 1, kind: 'mind.message.accepted', text: 'Please inspect this.' }),
    event({ eventId: 'wake-1', sequence: 2, kind: 'mind.wake', turnId: 'turn-1' }),
    event({ eventId: 'request-1', sequence: 3, kind: 'mind.model.request', turnId: 'turn-1', data: { providerId: 'example', model: 'model-a' } }),
    event({ eventId: 'annotation-1', sequence: 4, kind: 'mind.annotation.accepted', turnId: 'turn-1', text: 'Prefer the smaller change.', data: { targetEventId: 'request-1' } }),
    event({ eventId: 'complete-1', sequence: 5, kind: 'mind.turn.completed', turnId: 'turn-1' }),
  ];

  it('replays the same visible state after restart and ignores duplicate deliveries', () => {
    const replayed = projectPersistentMind([...stream].reverse().concat(stream[0]));
    expect(replayed).toEqual(projectPersistentMind(stream));
    expect(replayed).toMatchObject({
      status: 'idle',
      activeTurnId: null,
      lastCompletedTurnId: 'turn-1',
      eventCount: 5,
      messages: [{ eventId: 'message-1', text: 'Please inspect this.' }],
      annotations: [{ eventId: 'annotation-1', turnId: 'turn-1', targetEventId: 'request-1', text: 'Prefer the smaller change.' }],
      turns: [{ id: 'turn-1', status: 'completed', providerId: 'example', model: 'model-a', eventCount: 4 }],
    });
  });
});

describe('assemblePersistentMindContext', () => {
  const history = [
    event({ eventId: 'e1', sequence: 1, kind: 'mind.message.accepted', text: 'First message' }),
    event({ eventId: 'e2', sequence: 2, kind: 'mind.wake', turnId: 'turn-1' }),
    event({ eventId: 'e3', sequence: 3, kind: 'mind.turn.completed', turnId: 'turn-1' }),
    event({ eventId: 'e4', sequence: 4, kind: 'mind.message.accepted', text: 'Recent message' }),
    event({ eventId: 'e5', sequence: 5, kind: 'mind.wake', turnId: 'turn-2' }),
  ];

  const readyRollup = buildPersistentMindRollup({
    id: 'rollup-1',
    status: 'ready',
    summary: 'The first turn established the task boundary.',
    source: source(history.slice(0, 3)),
    providerId: 'example-provider',
    model: 'example-model',
    promptVersion: 1,
    createdAt: '2026-08-25T12:30:00.000Z',
  });

  it('stays within budget while including identity, provenance, summary, and recent raw events', () => {
    const context = assemblePersistentMindContext({
      identity: 'A stable resident Chief of Staff.',
      events: history,
      rollups: [readyRollup],
      recentEventLimit: 2,
      maxChars: 2_000,
    });

    expect(context.chars).toBeLessThanOrEqual(2_000);
    expect(context.summaryState).toBe('ready');
    expect(context.text).toContain('A stable resident Chief of Staff.');
    expect(context.text).toContain('example-provider/example-model; prompt v1');
    expect(context.text).toContain('The first turn established the task boundary.');
    expect(context.text).toContain('Recent message');
    expect(context.omittedRange).toMatchObject({ fromSequence: 1, toSequence: 3 });
  });

  it('keeps a ready rollup after its raw source events have expired', () => {
    const context = assemblePersistentMindContext({ events: [], rollups: [readyRollup] });
    expect(context.summaryState).toBe('ready');
    expect(context.text).toContain('The first turn established the task boundary.');
    expect(context.omittedRange).toMatchObject({ fromSequence: 1, toSequence: 3 });
  });

  it('includes every character accepted by the editable prompt contract', () => {
    const identity = `${'i'.repeat(3_999)}!`;
    const instructions = `${'o'.repeat(11_999)}!`;
    const context = assemblePersistentMindContext({ identity, instructions, maxChars: 32_000 });

    expect(context.identityChars).toBe(4_000);
    expect(context.instructionsChars).toBe(12_000);
    expect(context.text).toContain(identity);
    expect(context.text).toContain(instructions);
  });

  it('distinguishes empty, unavailable, failed, stale, and not-needed context', () => {
    expect(assemblePersistentMindContext().summaryState).toBe('empty');
    expect(assemblePersistentMindContext({ events: history.slice(-1) }).summaryState).toBe('not-needed');
    expect(assemblePersistentMindContext({ events: history, recentEventLimit: 2 }).summaryState).toBe('unavailable');

    const failed = buildPersistentMindRollup({
      id: 'failed-1',
      status: 'failed',
      error: 'provider unavailable',
      source: source(history.slice(0, 3)),
    });
    expect(assemblePersistentMindContext({ events: history, rollups: [failed], recentEventLimit: 2 }).summaryState)
      .toBe('failed');
    expect(assemblePersistentMindContext({ events: history, rollups: [readyRollup], recentEventLimit: 2, promptVersion: 2 }).summaryState)
      .toBe('stale');
  });
});

describe('per-call execution receipts in the replay projection', () => {
  const receipt = (sequence, overrides) => event({
    eventId: `call-${sequence}`,
    sequence,
    kind: 'mind.model.call',
    turnId: 'turn-1',
    data: {
      schemaVersion: 1,
      purpose: 'turn',
      round: 0,
      turnId: 'turn-1',
      runId: `run-${sequence}`,
      providerId: 'example-api',
      providerType: 'api',
      model: 'example-model',
      effort: 'high',
      thinkingPresetId: 'preset-deep',
      thinkingPresetLabel: 'Deep think',
      temporaryRoute: true,
      elapsedMs: 120,
      outcome: 'completed',
      reason: null,
      usage: { state: 'unknown', source: 'unavailable', inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null },
      displayText: 'turn round 0 on example-api/example-model — completed (120ms, usage unknown)',
      ...overrides,
    },
  });

  it('attaches each receipt to its turn with the route the call actually ran on', () => {
    const projection = projectPersistentMind([
      event({ eventId: 'wake-1', sequence: 1, kind: 'mind.wake', turnId: 'turn-1' }),
      receipt(2),
      receipt(3, { purpose: 'tool-round', round: 1, outcome: 'failed', reason: 'provider stream ended' }),
      event({ eventId: 'done-1', sequence: 4, kind: 'mind.turn.completed', turnId: 'turn-1' }),
    ]);
    const [turn] = projection.turns;
    expect(turn).toMatchObject({
      id: 'turn-1',
      status: 'completed',
      providerId: 'example-api',
      model: 'example-model',
      effort: 'high',
      thinkingPresetId: 'preset-deep',
    });
    expect(turn.calls.map((call) => [call.purpose, call.outcome, call.runId])).toEqual([
      ['turn', 'completed', 'run-2'],
      ['tool-round', 'failed', 'run-3'],
    ]);
    expect(turn.calls[0]).toMatchObject({ elapsedMs: 120, temporaryRoute: true, thinkingPresetLabel: 'Deep think' });
    expect(turn.calls[0].usage).toMatchObject({ state: 'unknown', totalTokens: null });
  });

  it('leaves a turn recorded before receipts existed with no telemetry rather than zeroes', () => {
    const projection = projectPersistentMind([
      event({ eventId: 'wake-old', sequence: 1, kind: 'mind.wake', turnId: 'turn-old' }),
      event({
        eventId: 'request-old',
        sequence: 2,
        kind: 'mind.model.request',
        turnId: 'turn-old',
        data: { providerId: 'example-api', model: 'example-model', effort: 'high' },
      }),
      event({ eventId: 'done-old', sequence: 3, kind: 'mind.turn.completed', turnId: 'turn-old' }),
    ]);
    expect(projection.turns[0]).toMatchObject({
      status: 'completed',
      providerId: 'example-api',
      calls: [],
      thinkingPresetId: null,
    });
  });
});

const route = {
  providerId: 'example-api',
  providerType: 'api',
  model: 'example-model',
  effort: 'high',
  thinkingPresetId: 'preset-deep',
  thinkingPresetLabel: 'Deep think',
  temporary: true,
};

describe('normalizePersistentMindCallUsage', () => {
  it('reports absent telemetry as unknown rather than zero', () => {
    for (const raw of [undefined, null, {}, [], 'nope', { inputTokens: 'many' }, { costUsd: NaN }]) {
      expect(normalizePersistentMindCallUsage(raw)).toEqual({
        state: 'unknown',
        source: 'unavailable',
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        costUsd: null,
      });
    }
  });

  it('keeps a genuinely reported zero distinct from missing telemetry', () => {
    expect(normalizePersistentMindCallUsage({ inputTokens: 0, outputTokens: 0 })).toMatchObject({
      state: 'reported',
      source: 'provider-reported',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('derives a total only when both halves were reported, and prefers a reported total', () => {
    expect(normalizePersistentMindCallUsage({ input_tokens: 120, output_tokens: 30 }).totalTokens).toBe(150);
    expect(normalizePersistentMindCallUsage({ inputTokens: 120 }).totalTokens).toBeNull();
    expect(normalizePersistentMindCallUsage({ inputTokens: 1, outputTokens: 1, totalTokens: 9 }).totalTokens).toBe(9);
  });

  it('treats a cost-only report as reported usage with unknown token counts', () => {
    expect(normalizePersistentMindCallUsage({ costUsd: 0.42 })).toMatchObject({
      state: 'reported',
      costUsd: 0.42,
      inputTokens: null,
      totalTokens: null,
    });
  });
});

describe('buildPersistentMindCallReceipt', () => {
  it('records the actual route, run id, elapsed time and outcome of one attempt', () => {
    const receipt = buildPersistentMindCallReceipt({
      turnId: 'mind-turn-1',
      purpose: 'tool-round',
      round: 2,
      runId: 'run-7',
      route,
      elapsedMs: 1234.6,
      outcome: 'completed',
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      purpose: 'tool-round',
      round: 2,
      turnId: 'mind-turn-1',
      runId: 'run-7',
      providerId: 'example-api',
      providerType: 'api',
      model: 'example-model',
      effort: 'high',
      thinkingPresetId: 'preset-deep',
      thinkingPresetLabel: 'Deep think',
      temporaryRoute: true,
      elapsedMs: 1235,
      outcome: 'completed',
      reason: null,
    });
    expect(receipt.displayText).toContain('example-api/example-model');
  });

  it('leaves elapsed time null for a call that never started', () => {
    const receipt = buildPersistentMindCallReceipt({
      turnId: 'mind-turn-1',
      purpose: 'summary',
      route,
      outcome: 'denied',
      reason: 'CoS actions budget exhausted',
    });
    expect(receipt.elapsedMs).toBeNull();
    expect(receipt.runId).toBeNull();
    expect(receipt.usage.state).toBe('unknown');
    expect(receipt.displayText).toContain('elapsed unknown');
  });

  it('cannot carry provider configuration, prompts, or hidden reasoning', () => {
    const receipt = buildPersistentMindCallReceipt({
      turnId: 'mind-turn-1',
      purpose: 'turn',
      round: 0,
      route: {
        ...route,
        apiKey: 'sk-secret-value',
        endpoint: 'https://provider.example.com/v1',
        headers: { authorization: 'Bearer sk-secret-value' },
      },
      elapsedMs: 5,
      outcome: 'completed',
      usage: { inputTokens: 3, apiKey: 'sk-secret-value', reasoning: 'hidden chain of thought' },
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain('sk-secret-value');
    expect(serialized).not.toContain('provider.example.com');
    expect(serialized).not.toContain('hidden chain of thought');
    expect(Object.keys(receipt).sort()).toEqual([
      'displayText', 'effort', 'elapsedMs', 'model', 'outcome', 'providerId', 'providerType',
      'purpose', 'reason', 'round', 'runId', 'schemaVersion', 'temporaryRoute', 'thinkingPresetId',
      'thinkingPresetLabel', 'turnId', 'usage',
    ]);
    expect(Object.keys(receipt.usage).sort()).toEqual([
      'costUsd', 'inputTokens', 'outputTokens', 'source', 'state', 'totalTokens',
    ]);
  });

  it('refuses an unknown outcome or purpose rather than storing it', () => {
    expect(() => buildPersistentMindCallReceipt({
      turnId: 'mind-turn-1', purpose: 'turn', route, outcome: 'maybe',
    })).toThrow();
    expect(() => buildPersistentMindCallReceipt({
      turnId: 'mind-turn-1', purpose: 'gossip', route, outcome: 'completed',
    })).toThrow();
  });
});

describe('publicPersistentMindCallReceipt', () => {
  it('projects only allowlisted fields from a stored event', () => {
    const projected = publicPersistentMindCallReceipt({
      eventId: 'mind-model-call:mind-turn-1:0',
      at: '2026-01-01T00:00:00.000Z',
      data: {
        purpose: 'turn',
        round: 0,
        runId: 'run-7',
        providerId: 'example-api',
        model: 'example-model',
        effort: 'high',
        thinkingPresetId: 'preset-deep',
        thinkingPresetLabel: 'Deep think',
        temporaryRoute: true,
        elapsedMs: 90,
        outcome: 'completed',
        usage: { inputTokens: 10, outputTokens: 2 },
        // A newer build's extra key, and something that must never be served.
        futureField: 'ignored',
        apiKey: 'sk-secret-value',
      },
    });
    expect(JSON.stringify(projected)).not.toContain('sk-secret-value');
    expect(projected).toMatchObject({ purpose: 'turn', runId: 'run-7', elapsedMs: 90, outcome: 'completed' });
    expect(projected.usage).toMatchObject({ state: 'reported', totalTokens: 12 });
    expect(Object.keys(projected)).not.toContain('futureField');
  });

  it('reads an unrecognized purpose/outcome as null instead of passing it through', () => {
    const projected = publicPersistentMindCallReceipt({ data: { purpose: 'gossip', outcome: 'maybe' } });
    expect(projected.purpose).toBeNull();
    expect(projected.outcome).toBeNull();
    expect(projected.usage.state).toBe('unknown');
  });
});
