/**
 * Operator-action ledger (#5594, epic #5593) — the durable, filterable record of
 * what the HUMAN did in PortOS.
 *
 * PortOS already logs a great deal, and none of it answers that question:
 * `history.jsonl` is PM2 lifecycle, `human_activity_events` is ingested external
 * activity (messages, calendar, media), the CoS JSONL ledgers are per-agent
 * transcripts, and `record_audit` is row-level before/after diffs. This store is
 * the one place that says "the user queued THIS task with THIS provider", "the
 * user rated THAT run negative", "the user changed these settings keys".
 *
 * Contract:
 * - **Closed vocabulary.** `type` must be in `USER_ACTION_TYPES`
 *   (`lib/userActionTypes.js`); an unknown type THROWS. A ledger whose type
 *   column is free text is a second `history.jsonl`, not a queryable log.
 * - **Idempotent.** Every event carries a stable `dedupeKey`; the unique
 *   `(type, dedupe_key)` index + `ON CONFLICT DO NOTHING` make a retried request
 *   a no-op. Same contract as `human_activity_events` / `tribe_touchpoints`.
 * - **Redacted.** Payload keys that look like a credential are dropped (value
 *   and all) and their paths listed under `payload.redactedKeys`, and long
 *   strings are truncated. A prompt or a settings patch can carry a token; the
 *   ledger must not become the place it leaks from.
 * - **Machine-local.** Never federated (PII must not ride the federation layer —
 *   ADR docs/decisions/2026-08-08-privacy-records-machine-local.md); guarded in
 *   sharing/peerSync.test.js. This log names what one operator did on one
 *   machine, which is exactly the kind of record that must not cross the wire.
 * - **Bounded.** Retention is enforced inline after an insert (row cap AND age
 *   cap) rather than by a new cron — one more scheduled job for a table that
 *   only grows when the user acts is not worth the moving part.
 *
 * PostgreSQL is authoritative. The file backend exists ONLY for the dev/test
 * escape hatch (`NODE_ENV=test` / `MEMORY_BACKEND=file`, see AGENTS.md's Storage
 * backend policy), which is what lets route suites assert a persisted row
 * without a database. It is deliberately built on `createPgFileFacade` rather
 * than copying `humanActivity.js`'s DB-only `ensureReady()` shape, which would
 * force every instrumented route's tests onto Postgres.
 *
 * Writes are AWAITED by their callers (same posture as `history.logAction`), so
 * a route's response implies the row landed and a test can assert it. No
 * fire-and-forget layer.
 */

import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import { createPgFileFacade, resolvePgBackend } from '../lib/pgFileFacade.js';
import { isTestRunner } from '../lib/db.js';
import { isUserActionActor, isUserActionType } from '../lib/userActionTypes.js';
import { insertUserActionEvent, listUserActionEvents, pruneUserActionEvents } from './userActionsDb.js';

// Resolved per call, not at module load: PATHS.data is re-rooted by the shared
// test proxy (lib/mockPathsDataRoot.js), and a load-time join would both bind the
// pre-mock value and crash any suite whose fileUtils stub omits PATHS.data.
const eventsFile = () => join(PATHS.data, 'user-action-events.json');

/** LLM-readable one-liner cap — the ledger is read by a model, not paged through. */
export const SUMMARY_MAX_CHARS = 240;
/** Per-string payload cap; the containing object gets `truncated: true`. */
export const PAYLOAD_STRING_MAX_CHARS = 4096;
/** Retention bounds. BOTH hold: no more rows than this, nothing older than this. */
export const DEFAULT_MAX_ROWS = 20_000;
export const DEFAULT_MAX_AGE_DAYS = 90;

/** List clamps — an unbounded read of an operator log is never what a caller wants. */
export const MAX_LIST_LIMIT = 500;
export const DEFAULT_LIST_LIMIT = 100;

let retention = { maxRows: DEFAULT_MAX_ROWS, maxAgeDays: DEFAULT_MAX_AGE_DAYS };

/**
 * Test seam — lower the retention bounds so a suite can prove pruning with a
 * handful of rows instead of 20,000. Production code never calls this; pass no
 * argument to restore the defaults.
 */
export function __setUserActionRetention({ maxRows, maxAgeDays } = {}) {
  retention = {
    maxRows: Number.isFinite(maxRows) && maxRows > 0 ? Math.floor(maxRows) : DEFAULT_MAX_ROWS,
    maxAgeDays: Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : DEFAULT_MAX_AGE_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for focused tests — no I/O, no side effects).
// ---------------------------------------------------------------------------

// Credential-shaped key names, matched against the key with separators and case
// removed (`api_key`, `apiKey`, `API-KEY` all normalize to `apikey`). Substring
// matching is deliberate over-redaction: dropping `tokenCount` costs one boring
// number, while missing `refreshToken` writes a live credential to disk.
const SECRET_KEY_FRAGMENTS = [
  'password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization',
  'credential', 'privatekey', 'ciphertext', 'cookie', 'accesskey',
];
// Names too short to substring-match safely (a bare `key` fragment would eat
// `keysChanged`, `env` would eat `envelope`), so they redact only as a WHOLE key.
const SECRET_KEY_EXACT = new Set(['key', 'keys', 'auth', 'env', 'dotenv', 'vault', 'pat', 'pw']);

const normalizeKey = (key) => String(key).toLowerCase().replace(/[^a-z0-9]/g, '');

/** True when a payload key name looks like it holds a credential. */
export function isSecretKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (SECRET_KEY_EXACT.has(normalized)) return true;
  // A trailing `Key`/`Keys` is how every provider-specific credential is named
  // (`openaiKey`, `sshKey`, `signingKey`, `deployKeys`), and none of them contain
  // the literal `apikey`. Anchoring at the END keeps `keysChanged` out.
  if (normalized.endsWith('key') || normalized.endsWith('keys')) return true;
  return SECRET_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/** Collapse whitespace and clamp to one LLM-readable line. */
export function clampSummary(text, max = SUMMARY_MAX_CHARS) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

// Recursive redact+truncate. Returns `{ value, truncated }` where `truncated`
// reports a truncation the CALLER must flag — an object flags its own children,
// so it always reports false upward; an array can't carry a flag, so it hands
// the responsibility to the nearest enclosing object.
function redactNode(value, path, redactedKeys) {
  if (typeof value === 'string') {
    return value.length > PAYLOAD_STRING_MAX_CHARS
      ? { value: `${value.slice(0, PAYLOAD_STRING_MAX_CHARS)}…`, truncated: true }
      : { value, truncated: false };
  }
  if (Array.isArray(value)) {
    let truncated = false;
    const out = value.map((item, index) => {
      const child = redactNode(item, path ? `${path}.${index}` : String(index), redactedKeys);
      truncated = truncated || child.truncated;
      return child.value;
    });
    return { value: out, truncated };
  }
  if (isPlainObject(value)) {
    const out = {};
    let truncated = false;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (isSecretKey(key)) {
        redactedKeys.push(childPath);
        continue;
      }
      const result = redactNode(child, childPath, redactedKeys);
      if (result.truncated) truncated = true;
      out[key] = result.value;
    }
    if (truncated) out.truncated = true;
    return { value: out, truncated: false };
  }
  return { value, truncated: false };
}

/**
 * Drop credential-shaped keys and truncate long strings.
 * @returns {{ payload: object, redactedKeys: string[] }} dotted paths of what was dropped.
 */
export function redactPayload(payload) {
  const redactedKeys = [];
  const { value } = redactNode(isPlainObject(payload) ? payload : {}, '', redactedKeys);
  return { payload: value, redactedKeys };
}

/**
 * Validate + normalize one action into the stored row shape. Throws on an
 * unknown type/actor or a missing dedupe key — all three are programmer errors
 * at a fixed hook site, and a silently-dropped row is worse than a red test.
 */
export function normalizeUserAction(input = {}) {
  const { type, actor = 'user', dedupeKey, summary } = input;
  if (!isUserActionType(type)) {
    throw new Error(`Unknown user action type '${String(type)}' — add it to USER_ACTION_TYPES first`);
  }
  if (!isUserActionActor(actor)) {
    throw new Error(`Unknown user action actor '${String(actor)}' for ${type}`);
  }
  const key = String(dedupeKey ?? '').trim();
  if (!key) throw new Error(`User action ${type} is missing a dedupeKey`);

  const when = input.happenedAt ? new Date(input.happenedAt) : new Date();
  if (Number.isNaN(when.getTime())) throw new Error(`User action ${type} has an invalid happenedAt`);

  // `redactedKeys` is written by the recorder alone — producers hand over raw
  // values and this is the single denylist that decides what is withheld.
  const { payload, redactedKeys } = redactPayload(input.payload);
  if (redactedKeys.length > 0) payload.redactedKeys = [...redactedKeys].sort();

  return {
    id: input.id || uuidv4(),
    type,
    actor,
    happenedAt: when.toISOString(),
    target: input.target ?? null,
    targetName: input.targetName ? clampSummary(input.targetName, SUMMARY_MAX_CHARS) : null,
    success: input.success !== false,
    summary: clampSummary(summary || type),
    payload,
    source: isPlainObject(input.source) ? input.source : {},
    dedupeKey: key,
  };
}

/** Clamp list options to the documented bounds. Exported for the route test. */
export function normalizeListOptions(options = {}) {
  const types = Array.isArray(options.types)
    ? options.types
    : (options.types ? [options.types] : []);
  const rawTypes = [
    ...(options.type ? [options.type] : []),
    ...types,
  ].filter((value) => typeof value === 'string' && value);
  const limit = Number.isFinite(Number(options.limit))
    ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(options.limit))))
    : DEFAULT_LIST_LIMIT;
  const offset = Number.isFinite(Number(options.offset))
    ? Math.max(0, Math.floor(Number(options.offset)))
    : 0;
  return {
    types: [...new Set(rawTypes)],
    actor: options.actor || null,
    target: options.target || null,
    // Absent (undefined/null) means "either"; only an explicit boolean filters.
    success: typeof options.success === 'boolean' ? options.success : null,
    from: options.from ? new Date(options.from).toISOString() : null,
    to: options.to ? new Date(options.to).toISOString() : null,
    limit,
    offset,
  };
}

// Id breaks the tie so the file backend orders identically to the PG backend's
// `ORDER BY happened_at DESC, id DESC` — otherwise two events stamped in the same
// millisecond would page differently depending on which backend answered.
const newestFirst = (a, b) => (
  String(b.happenedAt).localeCompare(String(a.happenedAt))
  || String(b.id).localeCompare(String(a.id))
);

// Shared by both backends so "what retention keeps" has ONE definition.
function retentionCutoff(now = Date.now()) {
  return new Date(now - retention.maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// File backend — dev/test escape hatch only.
// ---------------------------------------------------------------------------

// Every file write goes through one tail: the read-modify-write below would
// otherwise let two concurrent records clobber each other's row.
const queueWrite = createFileWriteQueue();

async function loadFileEvents() {
  const raw = await readJSONFile(eventsFile(), { events: [] }, { allowArray: false });
  return Array.isArray(raw?.events) ? raw.events : [];
}

function pruneEvents(events) {
  const cutoff = retentionCutoff();
  return events
    .filter((event) => String(event.happenedAt) >= cutoff)
    .sort(newestFirst)
    .slice(0, retention.maxRows);
}

function matchesFilters(event, filters) {
  if (filters.types.length > 0 && !filters.types.includes(event.type)) return false;
  if (filters.actor && event.actor !== filters.actor) return false;
  if (filters.target && event.target !== filters.target) return false;
  if (filters.success !== null && event.success !== filters.success) return false;
  if (filters.from && String(event.happenedAt) < filters.from) return false;
  if (filters.to && String(event.happenedAt) > filters.to) return false;
  return true;
}

function makeFileBackend() {
  return {
    name: 'file',
    record: (event) => queueWrite(async () => {
      const events = await loadFileEvents();
      if (events.some((row) => row.type === event.type && row.dedupeKey === event.dedupeKey)) return null;
      await ensureDir(PATHS.data);
      await atomicWrite(eventsFile(), { events: pruneEvents([...events, event]) });
      return event;
    }),
    list: async (filters) => {
      const events = await loadFileEvents();
      return events
        .filter((event) => matchesFilters(event, filters))
        .sort(newestFirst)
        .slice(filters.offset, filters.offset + filters.limit);
    },
  };
}

// ---------------------------------------------------------------------------
// PostgreSQL backend — authoritative. The SQL itself lives in userActionsDb.js
// (taking `db` as an argument) so `npm run test:db` can exercise it: this facade
// selects the FILE backend under NODE_ENV=test, which every DB-backed suite runs
// under. Same split as postRunStore.js / postRunDb.js.
// ---------------------------------------------------------------------------

function makePgBackend(db) {
  return {
    name: 'postgres',
    record: async (event) => {
      const inserted = await insertUserActionEvent(db, event);
      if (!inserted) return null;
      // Retention runs only after a row actually landed — a deduped retry must
      // not pay for two DELETE scans.
      await pruneUserActionEvents(db, { maxRows: retention.maxRows, cutoffIso: retentionCutoff() });
      return event;
    },
    list: (filters) => listUserActionEvents(db, filters),
  };
}

const facade = createPgFileFacade({
  // Vitest's VITEST marker is the resilient test signal when a wrapper drops
  // NODE_ENV; never let a focused route suite fall through to the live Postgres.
  isFile: () => process.env.MEMORY_BACKEND === 'file' || isTestRunner(),
  makeFile: makeFileBackend,
  makePg: () => resolvePgBackend({
    requirement: 'The operator-action ledger requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file)',
    loadDb: () => import('../lib/db.js'),
    makePg: makePgBackend,
  }),
});

// ---------------------------------------------------------------------------
// Public surface.
// ---------------------------------------------------------------------------

/**
 * Persist one operator action. Returns the stored event, or `null` when an event
 * with the same `(type, dedupeKey)` already exists (a retried request).
 *
 * @param {object} action
 * @param {string} action.type        One of USER_ACTION_TYPES; unknown values throw.
 * @param {string} [action.actor]     'user' (default) | 'mind' | 'schedule' | 'system'.
 * @param {string} [action.target]    Stable id of what was acted on (task id, agent id).
 * @param {string} [action.targetName] Human label for that target.
 * @param {boolean} [action.success]  Defaults true; pass false only when the handler
 *                                    already holds a structured failure result.
 * @param {string} action.summary     One LLM-readable line, clamped to 240 chars.
 * @param {object} [action.payload]   Structured detail; redacted + truncated here.
 * @param {object} [action.source]    `{ route, method }` or `{ service, fn }`.
 * @param {string} action.dedupeKey   Stable idempotency key; required.
 * @param {string|Date} [action.happenedAt] Defaults to now.
 */
export async function recordUserAction(action) {
  const event = normalizeUserAction(action);
  const backend = await facade.getBackend();
  return backend.record(event);
}

/** Read the ledger newest-first. See `normalizeListOptions` for the clamps. */
export async function listUserActions(options = {}) {
  const filters = normalizeListOptions(options);
  const backend = await facade.getBackend();
  return backend.list(filters);
}

/** Test seam — drop the memoized backend selection so a suite can re-select. */
export function _resetUserActionsBackend() {
  facade.reset();
}
