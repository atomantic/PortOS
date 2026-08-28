/**
 * Pure persistent-mind trajectory helpers.
 *
 * The machine-local run-event ledger owns persistence and ordering. This module
 * owns the mind-specific vocabulary, cursor shape, replay projection, rollup
 * record validation, and bounded context rendering so restart replay and live
 * reads use the same deterministic rules.
 */

import { z } from 'zod';
import { PERSISTENT_MIND_PROMPT_LIMITS } from './persistentMindPrompt.js';

export const PERSISTENT_MIND_ID = 'cos-persistent-mind';
export const PERSISTENT_MIND_ROLLUP_PROMPT_VERSION = 1;

export const PERSISTENT_MIND_EVENT_KINDS = Object.freeze([
  'mind.message.accepted',
  'mind.annotation.accepted',
  'mind.wake',
  'mind.model.request',
  'mind.model.result',
  'mind.thought',
  'mind.reply',
  'mind.memory.candidate',
  'mind.memory.created',
  'mind.memory.failed',
  'mind.capability.request',
  'mind.capability.result',
  'mind.summary',
  'mind.paused',
  'mind.failed',
  'mind.turn.completed',
  'mind.memory.promoted',
  'mind.maintenance.completed',
]);

const MIND_KIND_SET = new Set(PERSISTENT_MIND_EVENT_KINDS);

export const PERSISTENT_MIND_TRAJECTORY_LIMITS = Object.freeze({
  defaultPageSize: 100,
  maxPageSize: 500,
  recentContextEvents: 60,
  maxContextChars: 32_000,
  maxIdentityChars: PERSISTENT_MIND_PROMPT_LIMITS.identityChars,
  maxInstructionsChars: PERSISTENT_MIND_PROMPT_LIMITS.instructionsChars,
  maxMemoriesChars: 8_000,
  maxSummaryChars: 6_000,
  maxStoredRollups: 100,
  maxProjectedTurns: 100,
  maxProjectedInputs: 200,
});

export const persistentMindRollupSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1).max(160),
  mindId: z.string().min(1).max(128),
  status: z.enum(['ready', 'failed']),
  summary: z.string().max(PERSISTENT_MIND_TRAJECTORY_LIMITS.maxSummaryChars).nullable(),
  error: z.string().max(500).nullable(),
  source: z.object({
    fromSequence: z.number().int().nonnegative(),
    toSequence: z.number().int().nonnegative(),
    fromEventId: z.string().min(1).max(128),
    toEventId: z.string().min(1).max(128),
  }).strict(),
  provenance: z.object({
    providerId: z.string().max(128).nullable(),
    model: z.string().max(500).nullable(),
    promptVersion: z.number().int().positive(),
    createdAt: z.string().datetime(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  if (value.source.toSequence < value.source.fromSequence) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['source', 'toSequence'], message: 'must not precede fromSequence' });
  }
  if (value.status === 'ready' && value.summary === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['summary'], message: 'ready rollups require a summary string' });
  }
  if (value.status === 'failed' && !value.error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['error'], message: 'failed rollups require an error' });
  }
});

export function isPersistentMindEventKind(kind) {
  return MIND_KIND_SET.has(kind);
}

const orderedMindEvents = (events, mindId = PERSISTENT_MIND_ID) => {
  const seen = new Set();
  return (Array.isArray(events) ? events : [])
    .filter((event) => event?.mindId === mindId && isPersistentMindEventKind(event.kind))
    .filter((event) => {
      if (!event.eventId || seen.has(event.eventId)) return false;
      seen.add(event.eventId);
      return true;
    })
    .sort((a, b) => {
      const sequenceDelta = (Number.isSafeInteger(a.sequence) ? a.sequence : Number.MAX_SAFE_INTEGER)
        - (Number.isSafeInteger(b.sequence) ? b.sequence : Number.MAX_SAFE_INTEGER);
      if (sequenceDelta !== 0) return sequenceDelta;
      const timeDelta = String(a.at).localeCompare(String(b.at));
      return timeDelta || String(a.eventId).localeCompare(String(b.eventId));
    });
};

export function persistentMindEventCursor(event) {
  if (!Number.isSafeInteger(event?.sequence) || event.sequence < 0 || typeof event?.eventId !== 'string') return null;
  return `${event.sequence}:${event.eventId}`;
}

export function parsePersistentMindCursor(cursor) {
  if (typeof cursor !== 'string') return null;
  // Event ids commonly contain namespace colons (`mind-message:<id>`). The
  // first colon separates the numeric sequence; the remainder is opaque.
  const match = /^(\d+):(.{1,128})$/.exec(cursor);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? { sequence, eventId: match[2] } : null;
}

const displayText = (event) => (
  typeof event?.data?.displayText === 'string' ? event.data.displayText
    : typeof event?.data?.summaryText === 'string' ? event.data.summaryText
      : null
);

const emptyMindProjection = (mindId) => ({
  mindId,
  status: 'idle',
  activeTurnId: null,
  lastCompletedTurnId: null,
  lastEventAt: null,
  lastSequence: null,
  eventCount: 0,
  messages: [],
  annotations: [],
  turns: [],
});

/** Replay retained mind events into a stable, bounded visible projection. */
export function projectPersistentMind(events, mindId = PERSISTENT_MIND_ID) {
  const ordered = orderedMindEvents(events, mindId);
  const projection = emptyMindProjection(mindId);
  const turns = new Map();

  for (const event of ordered) {
    projection.eventCount += 1;
    projection.lastEventAt = event.at;
    projection.lastSequence = event.sequence;
    if (event.turnId && !turns.has(event.turnId)) {
      turns.set(event.turnId, {
        id: event.turnId,
        status: 'queued',
        startedAt: null,
        completedAt: null,
        providerId: null,
        model: null,
        effort: null,
        eventCount: 0,
      });
    }
    const turn = event.turnId ? turns.get(event.turnId) : null;
    if (turn) turn.eventCount += 1;

    switch (event.kind) {
      case 'mind.message.accepted':
        projection.messages.push({
          eventId: event.eventId,
          messageId: event.data?.messageId || null,
          turnId: event.turnId,
          at: event.at,
          text: displayText(event),
        });
        break;
      case 'mind.annotation.accepted':
        projection.annotations.push({
          eventId: event.eventId,
          annotationId: event.data?.annotationId || null,
          turnId: event.turnId,
          targetEventId: event.data?.targetEventId || null,
          at: event.at,
          text: displayText(event),
        });
        break;
      case 'mind.wake':
        projection.status = event.data?.status || 'thinking';
        projection.activeTurnId = event.turnId;
        if (turn) {
          turn.status = projection.status;
          turn.startedAt = turn.startedAt || event.at;
        }
        break;
      case 'mind.model.request':
        projection.status = 'thinking';
        projection.activeTurnId = event.turnId;
        if (turn) {
          turn.status = 'thinking';
          turn.startedAt = turn.startedAt || event.at;
          turn.providerId = event.data?.providerId || turn.providerId;
          turn.model = event.data?.model || turn.model;
          turn.effort = event.data?.effort || turn.effort;
        }
        break;
      case 'mind.paused':
        projection.status = event.data?.status || 'paused';
        projection.activeTurnId = null;
        if (turn) turn.status = projection.status;
        break;
      case 'mind.failed':
        projection.status = event.data?.status || 'failed';
        projection.activeTurnId = null;
        if (turn) {
          turn.status = projection.status;
          turn.completedAt = event.at;
        }
        break;
      case 'mind.turn.completed':
        projection.status = event.data?.status || 'idle';
        projection.activeTurnId = null;
        projection.lastCompletedTurnId = event.turnId;
        if (turn) {
          turn.status = 'completed';
          turn.completedAt = event.at;
        }
        break;
      default:
        break;
    }
  }

  projection.messages = projection.messages.slice(-PERSISTENT_MIND_TRAJECTORY_LIMITS.maxProjectedInputs);
  projection.annotations = projection.annotations.slice(-PERSISTENT_MIND_TRAJECTORY_LIMITS.maxProjectedInputs);
  projection.turns = [...turns.values()].slice(-PERSISTENT_MIND_TRAJECTORY_LIMITS.maxProjectedTurns);
  return projection;
}

export function isStoredPersistentMindRollup(value) {
  return persistentMindRollupSchema.safeParse(value).success;
}

const bounded = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '');

export function buildPersistentMindRollup({
  id,
  mindId = PERSISTENT_MIND_ID,
  status,
  summary = null,
  error = null,
  source,
  providerId = null,
  model = null,
  promptVersion = PERSISTENT_MIND_ROLLUP_PROMPT_VERSION,
  createdAt = new Date().toISOString(),
}) {
  return persistentMindRollupSchema.parse({
    schemaVersion: 1,
    id,
    mindId,
    status,
    summary: summary === null ? null : bounded(summary, PERSISTENT_MIND_TRAJECTORY_LIMITS.maxSummaryChars),
    error: error === null ? null : bounded(error, 500),
    source,
    provenance: {
      providerId: providerId ? bounded(providerId, 128) : null,
      model: model ? bounded(model, 500) : null,
      promptVersion,
      createdAt,
    },
  });
}

const renderEventLine = (event) => {
  const parts = [`[${event.at}]`, event.kind];
  if (event.turnId) parts.push(`turn=${event.turnId}`);
  const text = displayText(event);
  if (text !== null) parts.push(JSON.stringify(text));
  for (const key of ['providerId', 'model', 'effort', 'capability', 'status']) {
    const value = event.data?.[key];
    if (typeof value === 'string' && value) parts.push(`${key}=${value}`);
  }
  return parts.join(' ');
};

/**
 * Render stable identity + older rollups + recent verbatim events into a hard
 * character budget. Unavailable/failed/stale summary state is explicit;
 * a real empty history is `summaryState: "empty"`, never conflated with one.
 */
export function assemblePersistentMindContext({
  mindId = PERSISTENT_MIND_ID,
  identity = '',
  instructions = '',
  memories = [],
  events = [],
  rollups = [],
  maxChars = PERSISTENT_MIND_TRAJECTORY_LIMITS.maxContextChars,
  recentEventLimit = PERSISTENT_MIND_TRAJECTORY_LIMITS.recentContextEvents,
  promptVersion = PERSISTENT_MIND_ROLLUP_PROMPT_VERSION,
  coverageGap = null,
} = {}) {
  const cap = Math.max(1_000, Math.min(Number(maxChars) || PERSISTENT_MIND_TRAJECTORY_LIMITS.maxContextChars, 100_000));
  const ordered = orderedMindEvents(events, mindId);
  const recent = ordered.slice(-Math.max(1, recentEventLimit));
  const older = ordered.slice(0, Math.max(0, ordered.length - recent.length));
  const validRollups = (Array.isArray(rollups) ? rollups : [])
    .filter(isStoredPersistentMindRollup)
    .filter((rollup) => rollup.mindId === mindId)
    .sort((a, b) => a.source.fromSequence - b.source.fromSequence);

  // A rollup can outlive every raw event it summarizes. Select every sealed
  // range before the recent window, not only ranges that overlap retained raw
  // history, or a quiet mind would appear to forget its life after retention.
  const recentStart = recent[0]?.sequence ?? Number.POSITIVE_INFINITY;
  const selectedRollups = validRollups.filter((rollup) => rollup.source.toSequence < recentStart);
  const currentReadyRollups = selectedRollups
    .filter((rollup) => rollup.status === 'ready' && rollup.provenance.promptVersion === promptVersion);
  // Incremental summaries are cumulative. Keep only ranges that are not fully
  // superseded by another ready range so context never repeats every prior
  // version of the same life summary.
  const effectiveReadyRollups = currentReadyRollups.filter((candidate) => !currentReadyRollups.some((other) => (
    other.id !== candidate.id
      && other.source.fromSequence <= candidate.source.fromSequence
      && other.source.toSequence >= candidate.source.toSequence
  )));
  const hasOmittedHistory = older.length > 0 || selectedRollups.length > 0;
  let summaryState = !hasOmittedHistory
    ? (ordered.length === 0 ? 'empty' : 'not-needed')
    : 'unavailable';
  if (coverageGap) {
    summaryState = 'gap';
  } else if (hasOmittedHistory) {
    const stale = selectedRollups.some((rollup) => rollup.provenance.promptVersion !== promptVersion);
    const failed = selectedRollups.some((rollup) => rollup.status === 'failed');
    const everyOlderEventCovered = older.every((event) => effectiveReadyRollups.some((rollup) => (
      event.sequence >= rollup.source.fromSequence && event.sequence <= rollup.source.toSequence
    )));
    const everySelectedRangeCovered = selectedRollups.every((selected) => effectiveReadyRollups.some((rollup) => (
      selected.source.fromSequence >= rollup.source.fromSequence
        && selected.source.toSequence <= rollup.source.toSequence
    )));
    if (effectiveReadyRollups.length > 0 && everyOlderEventCovered && everySelectedRangeCovered) summaryState = 'ready';
    else if (failed) summaryState = 'failed';
    else if (stale) summaryState = 'stale';
  }

  const identityText = bounded(
    typeof identity === 'string' ? identity : JSON.stringify(identity),
    PERSISTENT_MIND_TRAJECTORY_LIMITS.maxIdentityChars
  );
  const instructionsText = bounded(
    typeof instructions === 'string' ? instructions : JSON.stringify(instructions),
    PERSISTENT_MIND_TRAJECTORY_LIMITS.maxInstructionsChars
  );
  const memoryLines = (Array.isArray(memories) ? memories : [])
    .filter((memory) => memory && typeof memory === 'object')
    .map((memory) => {
      const content = typeof memory.content === 'string' && memory.content.trim()
        ? memory.content.trim()
        : typeof memory.summary === 'string' ? memory.summary.trim() : '';
      if (!content) return null;
      const label = [memory.type, memory.category].filter(Boolean).join('/') || 'memory';
      return `- [${label}; id=${memory.id || 'unknown'}] ${content}`;
    })
    .filter(Boolean);
  const memoryText = bounded(
    memoryLines.join('\n'),
    PERSISTENT_MIND_TRAJECTORY_LIMITS.maxMemoriesChars
  );
  const prefix = [
    `# Persistent mind identity\nmindId=${mindId}${identityText ? `\n${identityText}` : ''}`,
    `# Operating instructions\n${instructionsText || '(none)'}`,
    `# Curated memories\n${memoryText || '(none)'}`,
  ].join('\n\n');
  const summaryLines = effectiveReadyRollups
    .map((rollup) => `[events ${rollup.source.fromSequence}-${rollup.source.toSequence}; ${rollup.provenance.providerId || 'unknown'}/${rollup.provenance.model || 'default'}; prompt v${rollup.provenance.promptVersion}]\n${rollup.summary}`);
  const omittedStarts = [selectedRollups[0]?.source.fromSequence, older[0]?.sequence].filter(Number.isSafeInteger);
  const omittedEnds = [older.at(-1)?.sequence, selectedRollups.at(-1)?.source.toSequence].filter(Number.isSafeInteger);
  const omittedStart = omittedStarts.length ? Math.min(...omittedStarts) : null;
  const omittedEnd = omittedEnds.length ? Math.max(...omittedEnds) : null;
  const statusLine = hasOmittedHistory
    ? `summary-cache=${summaryState}; omitted-events=${omittedStart}-${omittedEnd}`
    : `summary-cache=${summaryState}`;

  // Keep recent raw events available even if many large rollups exist. Older
  // summaries receive at most 45% of the post-header budget; newest summaries
  // win inside that bound, while recent events consume the remainder.
  const sectionOverhead = `\n\n# Older context\n${statusLine}\n\n# Recent trajectory\n`;
  const contentBudget = Math.max(0, cap - prefix.length - sectionOverhead.length);
  const summaryBudget = summaryLines.length ? Math.floor(contentBudget * 0.45) : 0;
  const keptSummaryLines = [];
  let summaryChars = 0;
  for (const line of [...summaryLines].reverse()) {
    const separator = keptSummaryLines.length ? 1 : 0;
    if (summaryChars + separator + line.length > summaryBudget) continue;
    keptSummaryLines.unshift(line);
    summaryChars += separator + line.length;
  }
  const recentBudget = contentBudget - summaryChars;
  const recentLines = [];
  let recentChars = 0;
  for (const event of [...recent].reverse()) {
    const line = renderEventLine(event);
    const separator = recentLines.length ? 1 : 0;
    if (recentChars + separator + line.length > recentBudget) continue;
    recentLines.unshift(line);
    recentChars += separator + line.length;
  }
  const sections = [
    prefix,
    `# Older context\n${statusLine}${keptSummaryLines.length ? `\n${keptSummaryLines.join('\n')}` : ''}`,
    `# Recent trajectory\n${recentLines.join('\n')}`,
  ];
  const text = sections.join('\n\n').slice(0, cap);
  return {
    mindId,
    text,
    chars: text.length,
    approximateTokens: Math.ceil(text.length / 4),
    summaryState,
    coverageGap,
    omittedRange: hasOmittedHistory ? {
      fromSequence: omittedStart,
      toSequence: omittedEnd,
      fromEventId: selectedRollups[0]?.source.fromEventId ?? older[0]?.eventId ?? null,
      toEventId: older.at(-1)?.eventId ?? selectedRollups.at(-1)?.source.toEventId ?? null,
    } : null,
    recentEventCount: recentLines.length,
    memoryCount: memoryLines.length,
    identityChars: identityText.length,
    instructionsChars: instructionsText.length,
  };
}
