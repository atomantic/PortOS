import { describe, expect, it } from 'vitest';
import {
  PERSISTENT_MIND_ID,
  assemblePersistentMindContext,
  buildPersistentMindRollup,
  parsePersistentMindCursor,
  persistentMindEventCursor,
  projectPersistentMind,
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
