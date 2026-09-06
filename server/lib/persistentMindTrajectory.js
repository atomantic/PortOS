/**
 * Pure persistent-mind trajectory helpers.
 *
 * The machine-local run-event ledger owns persistence and ordering. This module
 * owns the mind-specific vocabulary, cursor shape, replay projection, rollup
 * record validation, per-provider-call execution receipts, and bounded context
 * rendering so restart replay and live reads use the same deterministic rules.
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
  // One bounded receipt per PROVIDER CALL — the context summary, the turn, and
  // each tool round are separate attempts with their own run id, elapsed time,
  // outcome and usage provenance. `mind.model.result` still marks the turn's
  // overall answer. Older builds fold this kind as a no-op, so adding it is not
  // an envelope change.
  'mind.model.call',
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
  // Outbound FaceTime Audio calls. Every decision is written down, including
  // the ones that placed no call, so "why didn't it call me?" is answerable
  // from the trajectory alone. The dialed handle is never recorded.
  'mind.call.requested',
  'mind.call.placed',
  'mind.call.suppressed',
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
  // A turn is capped at one summary call plus MAX_TOOL_PROVIDER_ROUNDS provider
  // rounds, so this holds every receipt a healthy turn can produce with room for
  // the denied/failed attempts a contested one adds.
  maxProjectedCallsPerTurn: 12,
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
        thinkingPresetId: null,
        // Empty for a turn from before per-call receipts existed, and for one
        // that never reached a provider. Absent telemetry stays absent.
        calls: [],
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
          turn.thinkingPresetId = event.data?.thinkingPresetId || turn.thinkingPresetId;
        }
        break;
      case 'mind.model.call':
        if (turn) {
          // The receipt names the route the call ACTUALLY ran on, so it wins
          // over the request event's announced route.
          turn.providerId = event.data?.providerId || turn.providerId;
          turn.model = event.data?.model || turn.model;
          turn.effort = event.data?.effort || turn.effort;
          turn.thinkingPresetId = event.data?.thinkingPresetId || turn.thinkingPresetId;
          turn.calls = [...turn.calls, publicPersistentMindCallReceipt(event)]
            .slice(-PERSISTENT_MIND_TRAJECTORY_LIMITS.maxProjectedCallsPerTurn);
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
  for (const key of ['providerId', 'model', 'effort', 'capability', 'status', 'purpose', 'outcome']) {
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

// ---------------------------------------------------------------------------
// Per-call execution receipts
// ---------------------------------------------------------------------------

/**
 * A turn is not one provider call: the optional context summary is one, the
 * turn itself is another, and every tool round after it is another again. These
 * are the vocabulary and SHAPE of what each of those attempts is allowed to
 * write into the machine-local trajectory — the same job `buildPersistentMindRollup`
 * does for a sealed summary range.
 *
 * A receipt is built from named fields only and parsed through a `.strict()`
 * schema, so a caller cannot widen it by handing over a provider record, a
 * prompt, a response, or a hidden reasoning trace — an unknown key throws at the
 * call site rather than reaching the ledger. That matters because the inputs are
 * the live provider object and a raw error message.
 *
 * Missing telemetry is `unknown`, never zero. A provider that reports nothing
 * and a provider that genuinely used zero tokens are different facts, and
 * collapsing them would make the ledger claim a free call.
 */
export const PERSISTENT_MIND_CALL_PURPOSES = Object.freeze(['summary', 'turn', 'tool-round']);

export const PERSISTENT_MIND_CALL_OUTCOMES = Object.freeze(['completed', 'failed', 'denied', 'interrupted']);

export const PERSISTENT_MIND_CALL_USAGE_STATES = Object.freeze(['reported', 'unknown']);

export const PERSISTENT_MIND_CALL_RECEIPT_LIMITS = Object.freeze({
  idChars: 128,
  modelChars: 200,
  effortChars: 32,
  labelChars: 120,
  // The ledger scrubs and bounds ordinary strings at RUN_EVENT_LIMITS.maxStringChars
  // (200). Building a longer reason would only be truncated on write, so the two
  // bounds are kept equal and the stored receipt matches the built one.
  reasonChars: 200,
  displayChars: 300,
  maxRound: 64,
});

// Distinct from `bounded` above, which yields '' for a missing rollup field.
// A receipt field that was never present must serialize as null: '' would read
// as an empty provider id or model rather than as absent.
const nullableBounded = (value, max) => {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
};

// A token count or price is only real when the provider reported a finite,
// non-negative number. Anything else — absent, NaN, a string, a negative — is
// unknown, and must not be coerced into 0.
const reportedNumber = (value) => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
);

const firstReported = (...values) => {
  for (const value of values) {
    const reported = reportedNumber(value);
    if (reported !== null) return reported;
  }
  return null;
};

const usageSchema = z.object({
  state: z.enum(PERSISTENT_MIND_CALL_USAGE_STATES),
  source: z.enum(['provider-reported', 'unavailable']),
  inputTokens: z.number().nonnegative().nullable(),
  outputTokens: z.number().nonnegative().nullable(),
  totalTokens: z.number().nonnegative().nullable(),
  costUsd: z.number().nonnegative().nullable(),
}).strict();

export const persistentMindCallReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  purpose: z.enum(PERSISTENT_MIND_CALL_PURPOSES),
  round: z.number().int().nonnegative().max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.maxRound).nullable(),
  turnId: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
  runId: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars).nullable(),
  providerId: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars).nullable(),
  providerType: z.enum(['api', 'cli', 'tui']).nullable(),
  model: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.modelChars).nullable(),
  effort: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.effortChars).nullable(),
  thinkingPresetId: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars).nullable(),
  thinkingPresetLabel: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.labelChars).nullable(),
  temporaryRoute: z.boolean(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  outcome: z.enum(PERSISTENT_MIND_CALL_OUTCOMES),
  reason: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.reasonChars).nullable(),
  usage: usageSchema,
  displayText: z.string().min(1).max(PERSISTENT_MIND_CALL_RECEIPT_LIMITS.displayChars),
}).strict();

/**
 * Normalize whatever a provider result carried into an explicit usage record.
 *
 * @param {*} raw - a provider `usage` block, or nothing at all
 * @returns {{state: string, source: string, inputTokens: number|null,
 *   outputTokens: number|null, totalTokens: number|null, costUsd: number|null}}
 */
export function normalizePersistentMindCallUsage(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const inputTokens = firstReported(source.inputTokens, source.input_tokens, source.promptTokens, source.prompt_tokens);
  const outputTokens = firstReported(source.outputTokens, source.output_tokens, source.completionTokens, source.completion_tokens);
  const reportedTotal = firstReported(source.totalTokens, source.total_tokens);
  const totalTokens = reportedTotal ?? (
    inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null
  );
  // Only explicitly-denominated fields: a bare `cost` could be cents, and a
  // misread price is worse than an unknown one.
  const costUsd = firstReported(source.costUsd, source.cost_usd);
  const reported = [inputTokens, outputTokens, reportedTotal, costUsd].some((value) => value !== null);
  return {
    state: reported ? 'reported' : 'unknown',
    source: reported ? 'provider-reported' : 'unavailable',
    inputTokens,
    outputTokens,
    totalTokens: reported ? totalTokens : null,
    costUsd,
  };
}

/**
 * A refusal thrown by the per-call boundary — the call NEVER reached a
 * provider. It lives here rather than in the guard because several readers must
 * tell it apart from a provider failure without importing the guard's own
 * dependency graph: a refused summary must leave its range UNATTEMPTED, while a
 * summarizer that really ran and failed seals a failed rollup.
 */
export function buildPersistentMindCallDenial({ reason, status, requiresResubmission = false }) {
  return Object.assign(new Error(reason), {
    persistentMindCallDenied: true,
    deniedStatus: status,
    requiresResubmission: requiresResubmission === true,
  });
}

/** Was this thrown by the boundary refusing a call, rather than by the call? */
export function isPersistentMindCallDenial(error) {
  return error?.persistentMindCallDenied === true;
}

const receiptDisplayText = ({ purpose, round, providerId, model, outcome, elapsedMs, usage }) => {
  const route = [providerId || 'unknown-provider', model || 'default-model'].join('/');
  const roundLabel = round === null ? '' : ` round ${round}`;
  const elapsed = elapsedMs === null ? 'elapsed unknown' : `${elapsedMs}ms`;
  const tokens = usage.state === 'reported' && usage.totalTokens !== null
    ? `${usage.totalTokens} tokens`
    : 'usage unknown';
  return `${purpose}${roundLabel} on ${route} — ${outcome} (${elapsed}, ${tokens})`
    .slice(0, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.displayChars);
};

/**
 * Build one validated receipt for a provider call attempt.
 *
 * Every field is read by name. `route` is a plain descriptor, never the live
 * provider record — passing a provider object here would only contribute its
 * `id`/`type`, and any extra key fails the strict parse.
 *
 * @param {object} input
 * @param {string} input.turnId
 * @param {string} [input.purpose] - one of PERSISTENT_MIND_CALL_PURPOSES
 * @param {number} [input.round] - provider round within the turn, when it has one
 * @param {string} [input.runId] - the concrete run id the provider call created
 * @param {object} [input.route] - { providerId, providerType, model, effort,
 *   thinkingPresetId, thinkingPresetLabel, temporary }
 * @param {number} [input.elapsedMs] - wall time of the attempt; null when it never started
 * @param {string} input.outcome - one of PERSISTENT_MIND_CALL_OUTCOMES
 * @param {string} [input.reason] - denial/failure reason
 * @param {*} [input.usage] - raw provider usage block, if any
 * @returns {object} validated receipt payload
 */
export function buildPersistentMindCallReceipt({
  turnId,
  purpose,
  round = null,
  runId = null,
  route = {},
  elapsedMs = null,
  outcome,
  reason = null,
  usage = null,
} = {}) {
  const usageRecord = normalizePersistentMindCallUsage(usage);
  const providerType = route.providerType === 'api' || route.providerType === 'cli' || route.providerType === 'tui'
    ? route.providerType
    : null;
  const core = {
    schemaVersion: 1,
    purpose,
    round: Number.isSafeInteger(round) && round >= 0 ? round : null,
    turnId: nullableBounded(turnId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
    runId: nullableBounded(runId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
    providerId: nullableBounded(route.providerId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
    providerType,
    model: nullableBounded(route.model, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.modelChars),
    effort: nullableBounded(route.effort, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.effortChars),
    thinkingPresetId: nullableBounded(route.thinkingPresetId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
    thinkingPresetLabel: nullableBounded(route.thinkingPresetLabel, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.labelChars),
    temporaryRoute: route.temporary === true,
    elapsedMs: Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs) : null,
    outcome,
    reason: nullableBounded(reason, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.reasonChars),
    usage: usageRecord,
  };
  return persistentMindCallReceiptSchema.parse({
    ...core,
    displayText: receiptDisplayText(core),
  });
}

/**
 * Project one stored receipt into the safe public shape the Mind history
 * endpoint serves. Reads named fields only, so a ledger line written by a newer
 * build cannot smuggle an unknown key through the projection.
 */
export function publicPersistentMindCallReceipt(event) {
  const data = event?.data && typeof event.data === 'object' ? event.data : {};
  const usage = normalizePersistentMindCallUsage(data.usage);
  return {
    eventId: typeof event?.eventId === 'string' ? event.eventId : null,
    at: typeof event?.at === 'string' ? event.at : null,
    purpose: PERSISTENT_MIND_CALL_PURPOSES.includes(data.purpose) ? data.purpose : null,
    round: Number.isSafeInteger(data.round) ? data.round : null,
    runId: nullableBounded(data.runId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
    providerId: nullableBounded(data.providerId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
    model: nullableBounded(data.model, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.modelChars),
    effort: nullableBounded(data.effort, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.effortChars),
    thinkingPresetId: nullableBounded(data.thinkingPresetId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
    thinkingPresetLabel: nullableBounded(data.thinkingPresetLabel, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.labelChars),
    temporaryRoute: data.temporaryRoute === true,
    elapsedMs: Number.isSafeInteger(data.elapsedMs) && data.elapsedMs >= 0 ? data.elapsedMs : null,
    outcome: PERSISTENT_MIND_CALL_OUTCOMES.includes(data.outcome) ? data.outcome : null,
    reason: nullableBounded(data.reason, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.reasonChars),
    usage,
  };
}

/**
 * The per-turn execution summary the Mind history endpoint serves.
 *
 * Deliberately narrower than the full replay projection: turn identity, the
 * route the turn actually ran on, and its receipts. No message bodies, no
 * annotations, no free-form model text — a caller asking "what did this turn
 * spend, on what, and how did it end" gets exactly that.
 *
 * Turns with no receipts are omitted rather than served as empty rows: a turn
 * from before per-call receipts existed has unknown telemetry, and an empty
 * `calls` array would read as "it made no provider calls".
 */
export function publicPersistentMindTurnExecutions(projection, limit = 25) {
  const turns = Array.isArray(projection?.turns) ? projection.turns : [];
  return turns
    .filter((turn) => Array.isArray(turn?.calls) && turn.calls.length > 0)
    .slice(-Math.max(1, limit))
    .map((turn) => ({
      turnId: nullableBounded(turn.id, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
      status: nullableBounded(turn.status, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.effortChars),
      startedAt: typeof turn.startedAt === 'string' ? turn.startedAt : null,
      completedAt: typeof turn.completedAt === 'string' ? turn.completedAt : null,
      providerId: nullableBounded(turn.providerId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
      model: nullableBounded(turn.model, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.modelChars),
      effort: nullableBounded(turn.effort, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.effortChars),
      thinkingPresetId: nullableBounded(turn.thinkingPresetId, PERSISTENT_MIND_CALL_RECEIPT_LIMITS.idChars),
      calls: turn.calls,
    }));
}
