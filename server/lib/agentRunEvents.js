/**
 * CoS run event envelope — pure schema, redaction, and projection.
 *
 * The append-only ledger this describes is the *ordered* record of how a CoS
 * agent run reached its current state. It exists alongside the mutable run
 * record (`data/runs/{id}/metadata.json`), never instead of it: the record says
 * what a run is now, the ledger says how it got there, which is the question
 * the in-place record can never answer after an interruption or a recovery.
 *
 * Three properties make the stream trustworthy, and all three live here rather
 * than in the I/O service so they can be exercised without touching disk:
 *
 * - **Idempotent ids.** `buildRunEvent` derives `eventId` from the envelope's
 *   own content, so a boundary that fires twice for one logical transition (a
 *   retried orphan sweep, a duplicated runner completion) mints the SAME id and
 *   the ledger suppresses the second copy. A random id would have made every
 *   redelivery a new "fact" and quietly doubled every count derived from it.
 * - **Redaction at construction.** `redactRunEventData` runs inside
 *   `buildRunEvent`, so an unredacted payload can never reach the append path
 *   even if a future caller forgets. Prompts and record bodies are dropped, not
 *   truncated — a truncated prompt is still a prompt.
 * - **A pure fold.** `projectRunStates` derives status from the stream with no
 *   I/O and no clock, so "replay after restart" is the same code path as "read
 *   the current status", and a test can assert both with one call.
 *
 * The ledger is machine-local and never federated (see `docs/STORAGE.md`).
 * I/O, rotation, and the seen-id sets live in
 * `server/services/agentRunEventLog.js`.
 */

import { z } from 'zod';
import { homedir } from 'os';
import { sha256Text } from './fileUtils.js';
import { canonicalStringify, POLLUTING_KEYS } from './objects.js';
import { redactOutput } from './commandSecurity.js';
import {
  PERSISTENT_MIND_EVENT_KINDS,
  isPersistentMindEventKind,
} from './persistentMindTrajectory.js';

/**
 * Envelope schema version. Bump when the envelope SHAPE changes in a way a
 * reader must notice. The mind fields below are confined to a new kind
 * namespace, so ordinary v1 run envelopes remain byte-for-byte compatible;
 * adding a kind is not a shape change (unknown kinds fold as no-ops).
 *
 * This is deliberately NOT a `PORTOS_SCHEMA_VERSIONS` entry: the ledger never
 * crosses the wire, so no peer ever has to agree with this number.
 * A rollback to a build predating persistent-mind fields can drop `mind.*`
 * lines because that older strict envelope cannot validate them. That accepted
 * machine-local diagnostic loss is preferable to weakening today's typed
 * identity or pretending this non-authoritative replay aid is sync-versioned.
 */
export const AGENT_RUN_EVENT_SCHEMA_VERSION = 1;

/**
 * The lifecycle boundaries this slice records. Kept a closed vocabulary so the
 * projection below can be exhaustive and a typo in a call site fails schema
 * validation instead of silently writing an event nothing ever folds.
 */
export const AGENT_RUN_EVENT_KINDS = Object.freeze([
  // A run was created and its process handed off (createAgentRun).
  'run.spawned',
  // A run was closed with a verdict (completeAgentRun) — including the closes
  // driven by orphan cleanup, so `finalized` is genuinely terminal.
  'run.finalized',
  // A "running" agent record was found with no live process and reaped
  // (cleanupOrphanedAgents). Distinguishes a crash/restart from a clean exit.
  'run.orphan-recovered',
  // A restart survivor was re-adopted from the CoS Runner (syncRunnerAgents).
  'run.runner-recovered',
  // Process ownership moved between the in-server spawner and the CoS Runner.
  // The boundary that makes a run outlive the server, and the one an in-memory
  // ownership map forgets on restart.
  'run.handoff',
  // A live session re-attached to a still-running agent (TUI reattach). Says
  // 'someone was watching again', which is how a run with no output for an hour
  // is told from one nobody had open.
  'run.reconnected',
  // The run produced its FIRST output — once per run, never per chunk. Bounded
  // on purpose: per-chunk events would make the ledger a copy of the output it
  // deliberately redacts and would exhaust the retention bound in minutes. The
  // one event buys time-to-first-output, which is the only thing separating a
  // run that stalled after speaking from one that never spoke at all.
  'run.output',
  // The user (or a budget/queue gate) suspended a run.
  'run.paused',
  // A suspended run was resumed.
  'run.resumed',
  // An explicit stop/kill was requested. Distinct from 'run.finalized': the
  // request is the fact being recorded, and the exit it causes lands separately
  // — a kill that never took is exactly the discrepancy this ledger explains.
  'run.interrupted',
  // A PR-claim verification verdict was reached for the run's task.
  'run.pr-verified',
  // The durable run record was closed FROM this stream, because the ledger held
  // a verdict the record never received (see `lib/agentRunReconcile.js`). The
  // repair is itself a lifecycle fact: without it the record would show an
  // `endTime` that no exit ever produced, and nothing would say where it came
  // from. Adding this kind is not an envelope shape change — older builds fold
  // unknown kinds as no-ops — so AGENT_RUN_EVENT_SCHEMA_VERSION stays at 1.
  'run.reconciled'
]);

/** All writeable kinds in the shared machine-local ledger. */
export const RUN_EVENT_KINDS = Object.freeze([
  ...AGENT_RUN_EVENT_KINDS,
  ...PERSISTENT_MIND_EVENT_KINDS,
]);

const KIND_SET = new Set(RUN_EVENT_KINDS);
const AGENT_KIND_SET = new Set(AGENT_RUN_EVENT_KINDS);

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Keys whose values are prompts, model output, or record bodies. Dropped
 * wholesale — replaced by a `{ redacted, chars }` stub that preserves the one
 * diagnostically useful fact (how much there was) without preserving any of it.
 *
 * Matched case-insensitively so `taskDescription` and `promptText` are covered
 * by their stems.
 */
const DROPPED_KEY_PATTERNS = [
  /prompt/i,
  /description/i,
  /^output/i,
  /^content$/i,
  /^body$/i,
  /^text$/i,
  /^notes?$/i,
  /^summary$/i,
  /^title$/i,
  /^result$/i,
  /^params$/i,
  /^payload$/i,
  /^transcript/i,
  /^error$/i
];

/** Bounds. A ledger line must stay a diagnostic, not become a record copy. */
export const RUN_EVENT_LIMITS = Object.freeze({
  maxStringChars: 200,
  // Explicitly display-safe mind text is allowed to be useful context while
  // still bounded. Prompt/result/body keys never take this path.
  maxDisplayChars: 4_000,
  maxArrayItems: 20,
  maxObjectKeys: 40,
  maxDepth: 3
});

/**
 * Read-page bounds, here in the pure module rather than in the ledger service
 * because BOTH the service and the route's Zod schema must agree on them. A
 * route capped below the service's ceiling would 400 a request the service
 * would happily serve; a route capped above it would silently clamp instead.
 * `lib/cosValidation.js` imports these — a lib module must not reach into
 * `services/`, so the constants live on this side of that edge.
 */
export const RUN_EVENT_READ_LIMITS = Object.freeze({
  default: 200,
  max: 1000
});

const isDroppedKey = (key) => DROPPED_KEY_PATTERNS.some((re) => re.test(key));

/**
 * Replace the user's home directory prefix with `~` anywhere in a string.
 *
 * Workspace paths are the most common thing a lifecycle payload carries, and
 * `/Users/<name>/…` embeds the OS username. The ledger is machine-local, but a
 * diagnostic is exactly the thing a user pastes into a bug report, so the
 * username never gets written down in the first place.
 */
export function scrubHomePath(value) {
  const home = homedir();
  // A root-user container reports `/` as the home directory. Substituting on
  // that would rewrite every separator in every path (`/var/log` → `~var~log`),
  // destroying the diagnostic to protect a username that isn't in the string.
  if (typeof value !== 'string' || !home || home === '/' || home === '\\') return value;
  return value.split(home).join('~');
}

/**
 * Scrub + bound one free-form string: home path, then the shared secret filter,
 * then a hard length cap.
 */
function scrubString(value, maxChars = RUN_EVENT_LIMITS.maxStringChars) {
  const scrubbed = redactOutput(scrubHomePath(value)) ?? '';
  return scrubbed.length > maxChars
    ? `${scrubbed.slice(0, maxChars)}…`
    : scrubbed;
}

/**
 * Redact an event payload for the ledger.
 *
 * Recursive, bounded on every axis (depth, key count, array length, string
 * length), and it drops prototype-polluting keys the way every other sanitizer
 * in the codebase does. Non-JSON values (functions, symbols, undefined) are
 * dropped rather than stringified — a ledger line must round-trip through JSON.
 *
 * @param {*} data - arbitrary payload from a lifecycle call site
 * @param {number} [depth] - internal recursion depth
 * @returns {object} redacted, JSON-safe payload
 */
export function redactRunEventData(data, depth = 0) {
  if (data === null || data === undefined) return {};
  // The envelope's `data` is always an object (the schema is `z.record`), so a
  // scalar or array payload is boxed rather than rejected — a call site passing
  // one is imprecise, not a reason to lose the event.
  if (typeof data !== 'object') return { value: redactScalar(data) };
  if (Array.isArray(data)) return { items: redactValue(data, depth) };
  return redactValue(data, depth);
}

function redactScalar(value) {
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  return null;
}

function redactValue(value, depth) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return redactScalar(value);
  // A value nested past the depth cap is summarized, not walked — the cap is
  // what keeps a whole record from arriving as one deeply nested payload.
  if (depth >= RUN_EVENT_LIMITS.maxDepth) return { redacted: 'depth' };

  if (Array.isArray(value)) {
    const kept = value.slice(0, RUN_EVENT_LIMITS.maxArrayItems).map((item) => redactValue(item, depth + 1));
    return value.length > RUN_EVENT_LIMITS.maxArrayItems
      ? [...kept, { redacted: 'truncated', dropped: value.length - RUN_EVENT_LIMITS.maxArrayItems }]
      : kept;
  }

  const out = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (POLLUTING_KEYS.has(key)) continue;
    if (typeof raw === 'function' || typeof raw === 'symbol' || raw === undefined) continue;
    if (kept >= RUN_EVENT_LIMITS.maxObjectKeys) {
      out.redacted = 'keys';
      break;
    }
    // Only content-bearing values are dropped. A NUMBER or boolean under a
    // dropped key is a size or a flag (`promptChars`, `hasOutput`), never the
    // content itself — stubbing those out would delete the only part of the
    // payload that was already safe.
    if (isDroppedKey(key) && (typeof raw === 'string' || (raw !== null && typeof raw === 'object'))) {
      out[key] = { redacted: 'content', chars: typeof raw === 'string' ? raw.length : null };
    } else if ((key === 'displayText' || key === 'summaryText') && typeof raw === 'string') {
      out[key] = scrubString(raw, RUN_EVENT_LIMITS.maxDisplayChars);
    } else {
      out[key] = redactValue(raw, depth + 1);
    }
    kept += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Zod schema for one ledger line. `.strict()` so a call site cannot smuggle an
 * extra top-level field past redaction (redaction only walks `data`).
 */
const runEventEnvelopeSchema = z.object({
  schemaVersion: z.literal(AGENT_RUN_EVENT_SCHEMA_VERSION),
  eventId: z.string().min(1).max(128),
  kind: z.string().min(1).max(64),
  runId: z.string().min(1).max(128).nullable(),
  agentId: z.string().min(1).max(128).nullable(),
  taskId: z.string().min(1).max(128).nullable(),
  // Present only on persistent-mind events. Ordinary lifecycle envelopes keep
  // their exact pre-mind shape, so existing consumers do not grow fake ids.
  mindId: z.string().min(1).max(128).optional(),
  turnId: z.string().min(1).max(128).nullable().optional(),
  sequence: z.number().int().nonnegative().optional(),
  at: z.string().datetime(),
  data: z.record(z.unknown())
}).strict();

const refineKnownEventIdentity = (event, ctx) => {
  const mindEvent = isPersistentMindEventKind(event.kind);
  if (mindEvent && !event.mindId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mindId'], message: 'persistent-mind events require mindId' });
  }
  if (mindEvent && !Number.isSafeInteger(event.sequence)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sequence'], message: 'persistent-mind events require sequence' });
  }
  if (AGENT_KIND_SET.has(event.kind)
      && (event.mindId !== undefined || event.turnId !== undefined || event.sequence !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mindId'], message: 'ordinary run events cannot carry persistent-mind identity' });
  }
};

export const agentRunEventSchema = runEventEnvelopeSchema.extend({
  kind: z.enum(RUN_EVENT_KINDS),
}).superRefine(refineKnownEventIdentity);

/**
 * Structural envelope check for the READ path.
 *
 * Identical to `agentRunEventSchema` except `kind` is any bounded string rather
 * than the closed enum. A ledger file can outlive the build that wrote it — a
 * peer install, or this install before a downgrade, may have written kinds this
 * build has never heard of. Validating reads against the closed enum would drop
 * those lines, which both loses the trace and silently renumbers `eventCount`,
 * contradicting the forward-compatibility the projection already provides (it
 * folds unknown kinds as no-ops). Writes stay strict — a typo at a call site is
 * still a bug, and `buildRunEvent` is where it gets caught.
 */
export const storedRunEventSchema = runEventEnvelopeSchema.superRefine(refineKnownEventIdentity);

/** Is this parsed line a structurally sound ledger line? Used by the read path. */
export function isStoredRunEvent(value) {
  return storedRunEventSchema.safeParse(value).success;
}

const nullableId = (value) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 128) : null);

// Persistent-mind continuity is ledger metadata, not caller content. Keep it
// outside the bounded payload walk so a full caller object cannot evict the
// predecessor link that rollup coverage uses to detect a missing generation.
function redactEventData(data, mindEvent) {
  if (!mindEvent || !data || typeof data !== 'object' || Array.isArray(data)
      || !Object.hasOwn(data, 'previousSequence')) {
    return redactRunEventData(data);
  }
  const { previousSequence, ...callerData } = data;
  return {
    ...redactRunEventData(callerData),
    previousSequence,
  };
}

/**
 * Build a validated, redacted ledger envelope.
 *
 * `eventId` is content-derived by default: the sha256 of the canonicalized
 * envelope (kind + ids + timestamp + redacted data), truncated to 32 hex chars.
 * Two deliveries of the same logical transition therefore collide by design and
 * the ledger keeps one.
 *
 * **The timestamp is part of that hash**, so the content-derived id only dedupes
 * a redelivery when the caller passes the SAME `at` — which is the normal case,
 * because the stable lifecycle boundaries read theirs off the run record
 * (`metadata.startTime` / `metadata.endTime`). A caller that lets `at` default
 * to the wall clock is asserting that each occurrence is a distinct fact. When
 * it isn't — a sweep that can re-observe the same dead agent — pass an explicit
 * `eventId` naming the natural key instead.
 *
 * Throws on an invalid envelope — a malformed event is a bug at the call site,
 * and the append path (which owns the "never break a run for telemetry" rule)
 * is where that throw gets absorbed.
 *
 * @param {object} input
 * @param {string} input.kind - one of RUN_EVENT_KINDS
 * @param {string} [input.runId]
 * @param {string} [input.agentId]
 * @param {string} [input.taskId]
 * @param {string} [input.mindId] - required for persistent-mind kinds
 * @param {string} [input.turnId] - persistent-mind turn identity
 * @param {number} [input.sequence] - ledger-assigned mind ordering cursor
 * @param {string|Date} [input.at] - defaults to now
 * @param {object} [input.data] - redacted before it is hashed or stored
 * @param {string} [input.eventId] - explicit idempotency key
 * @returns {object} validated envelope
 */
export function buildRunEvent({ kind, runId, agentId, taskId, mindId, turnId, sequence, at, data, eventId } = {}) {
  const timestamp = at instanceof Date ? at.toISOString() : (typeof at === 'string' && at ? at : new Date().toISOString());
  const mindEvent = isPersistentMindEventKind(kind);
  const core = {
    schemaVersion: AGENT_RUN_EVENT_SCHEMA_VERSION,
    kind,
    runId: nullableId(runId),
    agentId: nullableId(agentId),
    taskId: nullableId(taskId),
    at: timestamp,
    data: redactEventData(data, mindEvent)
  };
  if (mindEvent) {
    core.mindId = nullableId(mindId);
    core.turnId = nullableId(turnId);
    core.sequence = sequence;
  }
  const envelope = {
    ...core,
    eventId: typeof eventId === 'string' && eventId ? eventId.slice(0, 128) : deriveEventId(core)
  };
  return agentRunEventSchema.parse(envelope);
}

/** Content-derived idempotency key for an envelope (sans its own id). */
export function deriveEventId(core) {
  return sha256Text(canonicalStringify(core) ?? '').slice(0, 32);
}

/** Is this parsed line a well-formed ledger event? Used by the read path. */
export function isValidRunEvent(value) {
  return agentRunEventSchema.safeParse(value).success;
}

/** Does this kind belong to the closed vocabulary? */
export function isKnownRunEventKind(kind) {
  return KIND_SET.has(kind);
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * The projection key for an event.
 *
 * Prefers `runId` — the durable identity a run keeps across restarts. Events
 * that legitimately have no run id (an orphan reaped before its run record was
 * written, or one whose `runId` never made it onto the agent record) fall back
 * to the agent, so they surface in diagnostics instead of vanishing. That case
 * is the exact failure this ledger exists to explain, so it must not be the one
 * the projection drops.
 */
export function runEventKey(event) {
  if (event?.runId) return event.runId;
  if (event?.agentId) return `agent:${event.agentId}`;
  return null;
}

const emptyProjection = (id) => ({
  id,
  runId: null,
  agentId: null,
  taskId: null,
  status: 'unknown',
  startedAt: null,
  endedAt: null,
  durationMs: null,
  exitCode: null,
  success: null,
  orphaned: false,
  interrupted: false,
  paused: false,
  recoveryCount: 0,
  handoffCount: 0,
  reconnectCount: 0,
  pauseCount: 0,
  owner: null,
  outputBytes: null,
  lastOutputAt: null,
  prVerified: null,
  reconciled: false,
  reconciledCount: 0,
  eventCount: 0,
  firstEventAt: null,
  lastEventAt: null,
  trace: []
});

/**
 * Fold an ordered event stream into per-run current state.
 *
 * Pure and clock-free: replaying the ledger after a restart produces exactly
 * the state the live process had, which is the whole point of the ledger. Later
 * events win on every field, so `run.finalized` correctly overrides an earlier
 * `run.orphan-recovered` (orphan cleanup emits both, in that order).
 *
 * Unknown kinds still count toward `eventCount` and the trace but leave status
 * alone, so a ledger written by a newer install replays on an older one.
 *
 * @param {object[]} events - ledger events in append order
 * @returns {object[]} projections, newest activity first
 */
export function projectRunStates(events) {
  const byKey = new Map();

  for (const event of Array.isArray(events) ? events : []) {
    const key = runEventKey(event);
    if (!key) continue;

    const state = byKey.get(key) ?? emptyProjection(key);
    if (!byKey.has(key)) byKey.set(key, state);

    // Ids are sticky: an event that omits one must not erase what an earlier
    // event established (the finalize path carries no taskId, for instance).
    state.runId = event.runId ?? state.runId;
    state.agentId = event.agentId ?? state.agentId;
    state.taskId = event.taskId ?? state.taskId;
    state.eventCount += 1;
    state.firstEventAt = state.firstEventAt ?? event.at;
    state.lastEventAt = event.at;
    state.trace.push({ eventId: event.eventId, kind: event.kind, at: event.at });

    applyKind(state, event);
  }

  return [...byKey.values()].sort((a, b) => String(b.lastEventAt).localeCompare(String(a.lastEventAt)));
}

/**
 * Has this run already reached a verdict?
 *
 * Every non-terminal arm below is guarded by this: the ledger is read in append
 * order, but a late-arriving annotation (a stop request that raced the exit, a
 * reconnect logged after the process was already reaped) must not resurrect a
 * finished run as `running`. `run.finalized` is the only arm that may set a
 * terminal status, so once set it stays.
 */
const isTerminal = (state) => state.status === 'completed' || state.status === 'failed';

/**
 * May an observation of live activity (a re-adoption, a stream re-attach) put
 * this run back to `running`?
 *
 * Not if it is finished, and not if it is PAUSED. Pause is the one non-terminal
 * state with its own explicit exit event (`run.resumed`): a paused run's process
 * has been stopped, so nothing should be observing it live, and letting one
 * flip the status would leave a projection reading `running` with `paused: true`
 * beside it.
 *
 * `orphaned` and `interrupted` deliberately DO yield. Both mean a stop was
 * observed or requested and neither guarantees it landed — a run re-adopted from
 * the runner after the sweep called it dead, or after a kill it ignored, really
 * is running, and that contradiction is the finding. The booleans stay true, so
 * the history is not lost either way.
 */
const canObserveRunning = (state) => !isTerminal(state) && !state.paused;

function applyKind(state, event) {
  const data = event.data ?? {};
  switch (event.kind) {
    case 'run.spawned':
      // Guarded like every other non-terminal arm. A spawn should never follow a
      // finalize for the same run, but the ledger is a stream several
      // independent call sites append to, and the one thing the fold must never
      // do is talk a finished run back into `running`. `startedAt` is first-wins
      // for the same reason: the first spawn is the run's real start.
      if (!isTerminal(state)) state.status = 'running';
      state.startedAt = state.startedAt ?? event.at;
      if (typeof data.providerId === 'string') state.providerId = data.providerId;
      if (typeof data.model === 'string') state.model = data.model;
      break;
    case 'run.runner-recovered':
      // A survivor is still running — recovery is an annotation on a live run,
      // not a terminal state. Only the count changes so a diagnostic can show
      // "this run has been re-adopted N times".
      if (canObserveRunning(state)) state.status = 'running';
      state.recoveryCount += 1;
      break;
    case 'run.orphan-recovered':
      state.orphaned = true;
      if (!isTerminal(state)) state.status = 'orphaned';
      break;
    case 'run.handoff':
      // Ownership moved. `owner` is the answer to "which process should I look
      // in for this run", which is precisely what the in-memory maps lose on a
      // restart — so the LAST handoff wins and the count shows the churn.
      state.handoffCount += 1;
      if (typeof data.to === 'string') state.owner = data.to;
      break;
    case 'run.reconnected':
      state.reconnectCount += 1;
      if (canObserveRunning(state)) state.status = 'running';
      break;
    case 'run.output':
      // Sizes only — the bytes themselves never enter the ledger.
      if (Number.isFinite(data.outputBytes)) state.outputBytes = data.outputBytes;
      state.lastOutputAt = event.at;
      break;
    case 'run.paused':
      state.paused = true;
      state.pauseCount += 1;
      if (!isTerminal(state)) state.status = 'paused';
      break;
    case 'run.resumed':
      state.paused = false;
      if (!isTerminal(state)) state.status = 'running';
      break;
    case 'run.interrupted':
      // The stop REQUEST, not the exit it causes. Status stays non-terminal on
      // purpose: a run still showing `interrupted` with no later
      // `run.finalized` is a kill that never landed, and hiding that behind a
      // synthesized "failed" would erase the only evidence of it.
      state.interrupted = true;
      if (typeof data.reason === 'string') state.interruptReason = data.reason;
      if (!isTerminal(state)) state.status = 'interrupted';
      break;
    case 'run.pr-verified':
      state.prVerified = data.verified === true;
      if (typeof data.prUrl === 'string') state.prUrl = data.prUrl;
      break;
    case 'run.reconciled':
      // The record was closed from the stream. Recorded as a terminal status so
      // the projection agrees with the record it just repaired — otherwise the
      // next replay would still read `orphaned` beside a record that now says
      // `failed`, which is the exact disagreement the repair removed.
      // `state.orphaned` and `state.interrupted` are untouched, so how it ended
      // is not lost to how it was closed.
      state.reconciled = true;
      state.reconciledCount += 1;
      state.endedAt = state.endedAt ?? event.at;
      if (typeof data.success === 'boolean' && !isTerminal(state)) {
        state.status = data.success ? 'completed' : 'failed';
        state.success = data.success;
      }
      break;
    case 'run.finalized': {
      const success = data.success === true;
      state.status = success ? 'completed' : 'failed';
      state.success = success;
      state.endedAt = event.at;
      state.exitCode = Number.isFinite(data.exitCode) ? data.exitCode : null;
      state.durationMs = Number.isFinite(data.durationMs) ? data.durationMs : null;
      // The finalize event carries the run's TOTAL output size — the only place
      // a real byte count exists. `run.output` marks the first byte, not the
      // last, so without this the projection's `outputBytes` would be null for
      // every completed run.
      if (Number.isFinite(data.outputBytes)) state.outputBytes = data.outputBytes;
      if (typeof data.errorCategory === 'string') state.errorCategory = data.errorCategory;
      break;
    }
    default:
      // Unknown kind from a newer install — counted, not interpreted.
      break;
  }
}

/** Project a single key out of a stream (`runId`, or `agent:<agentId>`). */
export function projectRunState(events, id) {
  return projectRunStates(events).find((state) => state.id === id) ?? null;
}
