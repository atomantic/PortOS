/**
 * Human Activity timeline (#2150) — unified, machine-local event store.
 *
 * All ingestion sources (message/calendar syncs today; iMessage, Spotify,
 * YouTube, Signal in later phases) write normalized events into the
 * `human_activity_events` Postgres table via `recordEvents()`. The store is:
 *
 * - **Idempotent.** Every event carries a stable `dedupeKey`; the unique
 *   `(source, dedupe_key)` index + `ON CONFLICT DO NOTHING` make re-syncs no-ops.
 *   Same contract as `tribe_touchpoints.dedupe_key`.
 * - **Privacy-preserving.** Events store metadata + a SHORT summary line only —
 *   full message bodies stay in the per-source caches (`data/messages/cache/`,
 *   chat.db, …). `metadata` carries pointers (threadId / externalId / account) back
 *   to the source so a consumer can rehydrate the full body on demand.
 * - **Machine-local.** Coupled to per-machine accounts and OS databases; NOT
 *   federated (ADR docs/decisions/2026-06-26-tribe-and-universe-runs-local.md,
 *   guarded in sharing/peerSync.test.js). Derived summaries federate via existing
 *   rails (Brain journals, digital-twin), not the raw events.
 *
 * Ingestion is LLM-free and deterministic; identity matching reuses the tribe
 * email/handle index. No AI-provider calls happen here.
 */
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureSchema, query } from '../lib/db.js';
import { getUserTimezone, getLocalParts, getUtcOffsetMs, todayInTimezone } from '../lib/timezone.js';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no side effects).
// ---------------------------------------------------------------------------

// Collapse whitespace and clamp to a short single line. Guards the privacy
// contract: we keep a preview, never the full body.
export function shortSummary(text, max = 160) {
  if (!text) return '';
  const line = String(text).replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}

// A stable local-day key (YYYY-MM-DD) for a timestamp in the user's timezone.
// Using the UTC day would split one local evening across two days whenever an
// event straddles UTC midnight (common in the Americas).
export function localDayKey(when, timezone) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return null;
  const p = getLocalParts(d, timezone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// UTC instant of local midnight for a (y, m, d) calendar date in `timezone`.
// The offset is sampled at the approximate midnight, then the candidate is
// verified with the formatter-based getLocalParts and nudged by the exact
// landed-vs-desired delta (the same DST correction pattern as nextLocalTime in
// lib/timezone.js). getUtcOffsetMs alone is NOT re-sampled at the candidate —
// its toLocaleString round-trip mis-parses ambiguous wall-clock times right at
// a transition, which is exactly when the correction matters.
function localMidnightUtc(y, mo, d, timezone) {
  const approxUtc = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  const offset = getUtcOffsetMs(approxUtc, timezone);
  let t = approxUtc.getTime() - offset;
  const p = getLocalParts(new Date(t), timezone);
  const desired = Date.UTC(y, mo - 1, d);
  const landed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  if (landed !== desired) t -= landed - desired;
  return new Date(t);
}

// UTC [start, end) instants that bound a local calendar day (YYYY-MM-DD) in the
// given timezone. The end is the NEXT local date's midnight — not start + 24h —
// so DST transition days keep their true 23h/25h length instead of leaking an
// hour into (or dropping an hour from) the neighboring day.
export function localDayRangeUtc(dateStr, timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const start = localMidnightUtc(y, mo, d, timezone);
  // Date.UTC rolls d+1 over month/year boundaries for us.
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  const end = localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), timezone);
  return { start, end };
}

// Normalize a participant to { name, email, phone, personId } — trimmed, empty
// fields dropped. Accepts a bare email string or a { name, email, phone } object.
export function normalizeParticipant(p) {
  if (!p) return null;
  const raw = typeof p === 'string' ? { email: p } : p;
  const out = {};
  if (raw.name) out.name = String(raw.name).trim();
  if (raw.email) out.email = String(raw.email).trim().toLowerCase();
  if (raw.phone) out.phone = String(raw.phone).trim();
  if (raw.personId) out.personId = String(raw.personId);
  return out.name || out.email || out.phone || out.personId ? out : null;
}

export function normalizeParticipants(list) {
  if (!Array.isArray(list)) return [];
  return list.map(normalizeParticipant).filter(Boolean);
}

// Normalize a raw ingestion candidate into the DB row shape, or null if it's
// missing a required field (source / kind / happened_at / dedupeKey). A candidate
// may supply its own id (stable across re-derivations) or get a fresh uuid.
export function normalizeCandidate(candidate) {
  if (!candidate) return null;
  const source = String(candidate.source || '').trim();
  const kind = String(candidate.kind || '').trim();
  const dedupeKey = String(candidate.dedupeKey ?? candidate.dedupe_key ?? '').trim();
  const when = candidate.happenedAt ?? candidate.happened_at;
  const happenedAt = when ? new Date(when) : null;
  if (!source || !kind || !dedupeKey || !happenedAt || Number.isNaN(happenedAt.getTime())) {
    return null;
  }
  const durationRaw = candidate.durationS ?? candidate.duration_s;
  const durationS = Number.isFinite(Number(durationRaw)) ? Math.round(Number(durationRaw)) : null;
  return {
    id: candidate.id || uuidv4(),
    source,
    accountId: candidate.accountId ?? candidate.account_id ?? null,
    kind,
    happenedAt: happenedAt.toISOString(),
    durationS,
    title: candidate.title ? shortSummary(candidate.title, 300) : null,
    summary: candidate.summary ? shortSummary(candidate.summary) : null,
    url: candidate.url || null,
    participants: normalizeParticipants(candidate.participants),
    metadata: candidate.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {},
    dedupeKey,
  };
}

// Bucket events into a 24-slot local-hour histogram: [{ hour, count }].
export function hourlyHistogram(events, timezone) {
  const counts = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
  for (const ev of events || []) {
    const d = new Date(ev.happenedAt ?? ev.happened_at);
    if (Number.isNaN(d.getTime())) continue;
    const { hour } = getLocalParts(d, timezone);
    if (hour >= 0 && hour < 24) counts[hour].count += 1;
  }
  return counts;
}

// Tally events by source and by kind: { bySource: {…}, byKind: {…}, total }.
export function summarizeCounts(events) {
  const bySource = {};
  const byKind = {};
  for (const ev of events || []) {
    const source = ev.source || 'unknown';
    const kind = ev.kind || 'unknown';
    bySource[source] = (bySource[source] || 0) + 1;
    byKind[kind] = (byKind[kind] || 0) + 1;
  }
  return { bySource, byKind, total: (events || []).length };
}

// ---------------------------------------------------------------------------
// Ingestion mappers (pure — turn source-specific records into candidates).
// Kept here so the sync-hook glue in messageSync.js / calendarSync.js stays a
// thin `.catch()`-guarded call, and so mapping is unit-testable without a DB.
// ---------------------------------------------------------------------------

function participantEmail(p) {
  if (!p) return '';
  return String((typeof p === 'string' ? p : p.email) || '').trim().toLowerCase();
}

// Map an account's cached messages to activity candidates. Direction (sent vs
// received) is derived deterministically from the sender vs the account owner.
export function messageActivityCandidates(account, messages = []) {
  const selfEmail = String(account?.email || '').trim().toLowerCase();
  const source = account?.type || 'message';
  const accountId = account?.id || null;
  const out = [];
  for (const message of messages || []) {
    const when = message?.date || message?.happenedAt;
    if (!when) continue;
    const externalId = message.externalId || message.id;
    if (!externalId) continue;
    const fromEmail = participantEmail(message.from);
    // Direction by exact From-vs-owner match. NOTE: a reply sent from a Gmail
    // "send-as" alias (From ≠ account.email) is classified as received, not sent —
    // send-as aliases aren't stored per account, so we can't recognize them here.
    // Bounded impact: such a reply won't cancel its inbound in outreach detection.
    const sent = Boolean(selfEmail) && fromEmail === selfEmail;
    const participants = normalizeParticipants([
      message.from,
      ...(message.to || []),
      ...(message.cc || []),
    ]).filter((p) => !(p.email && p.email === selfEmail));
    out.push({
      source,
      accountId,
      kind: sent ? 'message.sent' : 'message.received',
      happenedAt: when,
      title: message.subject || '(no subject)',
      summary: shortSummary(message.bodyText || message.snippet || ''),
      participants,
      dedupeKey: `msg:${accountId || 'x'}:${externalId}`,
      metadata: {
        threadId: message.threadId || null,
        externalId,
        channel: source,
        // The counterpart handle for a RECEIVED message is the sender's email —
        // set it so `enrichActivityEvent` (which resolves the top-level personId
        // from `metadata.handle`) can tag the Tribe sender, exactly as the iMessage
        // mapper does. Without this, email inbound never resolves to a person and
        // Tribe-outreach detection (#2796) drops every Gmail thread. Sent turns
        // carry no counterpart handle (mirrors iMessage); email threads group by
        // `threadId`, so handle is never the grouping key here.
        handle: sent ? null : (fromEmail || null),
      },
    });
  }
  return out;
}

// Resolve a calendar time value to a UTC instant, interpreting OFFSET-LESS
// values in the given timezone instead of the Node process's OS timezone.
// Google all-day events are normalized to "YYYY-MM-DDT00:00:00" (no offset) —
// `new Date()` would parse that as server-OS-local, so for a user west of UTC
// an all-day July 4 event could land inside July 3's local-day window. Values
// with an explicit offset (Z / ±hh:mm) pass straight through.
export function resolveEventInstant(value, timezone) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?$/.exec(s);
  if (m && timezone) {
    const [, y, mo, d, hh, mm, ss] = m;
    const midnight = localMidnightUtc(Number(y), Number(mo), Number(d), timezone);
    const dayMs = ((Number(hh) || 0) * 3600 + (Number(mm) || 0) * 60 + (Number(ss) || 0)) * 1000;
    return new Date(midnight.getTime() + dayMs);
  }
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Map calendar events to activity candidates. Only events that have already
// happened (end/start <= now) and weren't declined/cancelled count as activity,
// mirroring the tribe touchpoint gate. `timezone` (the user's configured IANA
// zone) anchors offset-less/all-day values; without it they fall back to
// `new Date()` semantics.
export function calendarActivityCandidates(account, events = [], now = Date.now(), timezone = null) {
  const accountId = account?.id || null;
  const out = [];
  for (const event of events || []) {
    if (event?.isCancelled || event?.myStatus === 'declined') continue;
    const startedAt = resolveEventInstant(event.startTime, timezone) || resolveEventInstant(event.endTime, timezone);
    if (!startedAt) continue;
    const completedAt = resolveEventInstant(event.endTime, timezone) || startedAt;
    if (completedAt.getTime() > now) continue; // not finished yet
    const eventKey = event.externalId || event.id;
    if (!eventKey) continue;
    const start = resolveEventInstant(event.startTime, timezone)?.getTime();
    const end = resolveEventInstant(event.endTime, timezone)?.getTime();
    const durationS = Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.round((end - start) / 1000)
      : null;
    out.push({
      source: 'calendar',
      accountId,
      kind: 'calendar.event',
      happenedAt: startedAt.toISOString(),
      durationS,
      title: event.title || '(untitled event)',
      summary: shortSummary(event.location || event.description || ''),
      participants: normalizeParticipants([event.organizer, ...(event.attendees || [])].filter(Boolean)),
      dedupeKey: `cal:${accountId || 'x'}:${eventKey}`,
      metadata: {
        externalId: eventKey,
        location: event.location || null,
        startTime: event.startTime || null,
        endTime: event.endTime || null,
        subcalendarId: event.subcalendarId || null,
      },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// DB access.
// ---------------------------------------------------------------------------

let schemaReady = false;
async function ensureReady() {
  if (schemaReady) return;
  await ensureSchema();
  schemaReady = true;
}

function rowToEvent(row) {
  return {
    id: row.id,
    source: row.source,
    accountId: row.account_id,
    kind: row.kind,
    happenedAt: row.happened_at instanceof Date ? row.happened_at.toISOString() : row.happened_at,
    durationS: row.duration_s,
    title: row.title,
    summary: row.summary,
    url: row.url,
    participants: row.participants || [],
    metadata: row.metadata || {},
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

// Idempotently persist a batch of activity candidates. Returns
// { recorded, skipped } where `recorded` is the count of newly-inserted rows and
// `skipped` counts duplicates (already present for this source+dedupeKey) plus
// any candidate that failed normalization.
export async function recordEvents(candidates = []) {
  const rows = (candidates || []).map(normalizeCandidate).filter(Boolean);
  if (rows.length === 0) return { recorded: 0, skipped: (candidates || []).length };
  await ensureReady();

  // Chunk the multi-row insert so a large batch (the message hook passes the full
  // capped cache each sync) can't exceed Postgres's 65535-param-per-statement
  // limit — 12 params/row, so a 500-row chunk stays well under it.
  const CHUNK = 500;
  let recorded = 0;
  for (let start = 0; start < rows.length; start += CHUNK) {
    recorded += await insertActivityChunk(rows.slice(start, start + CHUNK));
  }
  const skipped = (candidates || []).length - recorded;
  if (recorded > 0) {
    console.log(`🗓️  Recorded ${recorded} activity event(s) (${skipped} skipped as duplicate/invalid)`);
  }
  return { recorded, skipped };
}

// Insert one chunk of normalized rows; returns the count actually inserted.
// 12 bound params per row (created_at is a NOW() literal, not a param);
// participants and metadata are JSON.stringify'd + ::jsonb-cast (node-pg would
// otherwise coerce a JS array to a Postgres array literal and fail on jsonb).
async function insertActivityChunk(rows) {
  const paramsPerRow = 12;
  const values = [];
  const placeholders = rows.map((r, i) => {
    const b = i * paramsPerRow;
    values.push(
      r.id, r.source, r.accountId, r.kind, r.happenedAt, r.durationS,
      r.title, r.summary, r.url, JSON.stringify(r.participants),
      JSON.stringify(r.metadata), r.dedupeKey,
    );
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}::jsonb, $${b + 11}::jsonb, $${b + 12}, NOW())`;
  });
  const result = await query(
    `INSERT INTO human_activity_events
       (id, source, account_id, kind, happened_at, duration_s, title, summary, url, participants, metadata, dedupe_key, created_at)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (source, dedupe_key) DO NOTHING
     RETURNING id`,
    values,
  );
  return result.rowCount || 0;
}

// Query events with optional filters. `from`/`to` are ISO timestamps (inclusive
// lower, exclusive upper); `personId` matches a participant via the JSONB
// containment operator. `chatGuid` / `handle` match iMessage-style metadata
// pointers. Newest first, capped by `limit` (default 500, max 2000).
export async function listEvents({ from, to, source, kind, personId, chatGuid, conversationId, threadId, handle, limit } = {}) {
  await ensureReady();
  const clauses = [];
  const params = [];
  if (from) { params.push(new Date(from).toISOString()); clauses.push(`happened_at >= $${params.length}`); }
  if (to) { params.push(new Date(to).toISOString()); clauses.push(`happened_at < $${params.length}`); }
  if (source) { params.push(source); clauses.push(`source = $${params.length}`); }
  if (kind) { params.push(kind); clauses.push(`kind = $${params.length}`); }
  if (personId) {
    params.push(JSON.stringify([{ personId: String(personId) }]));
    clauses.push(`participants @> $${params.length}::jsonb`);
  }
  if (chatGuid != null && String(chatGuid).length > 0) {
    params.push(String(chatGuid));
    clauses.push(`metadata->>'chatGuid' = $${params.length}`);
  }
  if (conversationId != null && String(conversationId).length > 0) {
    params.push(String(conversationId));
    clauses.push(`metadata->>'conversationId' = $${params.length}`);
  }
  if (threadId != null && String(threadId).length > 0) {
    params.push(String(threadId));
    clauses.push(`metadata->>'threadId' = $${params.length}`);
  }
  if (handle != null && String(handle).length > 0) {
    params.push(String(handle));
    clauses.push(`metadata->>'handle' = $${params.length}`);
  }
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  params.push(cap);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const result = await query(
    `SELECT * FROM human_activity_events
     ${where}
     ORDER BY happened_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map(rowToEvent);
}

/**
 * Delete activity events by explicit id list and/or filters. Returns `{ deleted }`.
 *
 * Safety: refuses unbounded wipes. Accepts either:
 *   - `ids` (optionally scoped with `source`), or
 *   - `source` + (`chatGuid` and/or `handle`)
 *
 * Used by PortOS-side managers (iMessage #2413, later Signal/etc.) — never
 * mutates the external source (chat.db, Gmail, …).
 */
export async function deleteEvents({ ids, source, chatGuid, handle } = {}) {
  await ensureReady();
  const hasIds = Array.isArray(ids) && ids.length > 0;
  const hasChat = chatGuid != null && String(chatGuid).length > 0;
  const hasHandle = handle != null && String(handle).length > 0;
  if (!hasIds && !(source && (hasChat || hasHandle))) return { deleted: 0 };

  const clauses = [];
  const params = [];
  if (hasIds) {
    params.push(ids.map(String));
    clauses.push(`id = ANY($${params.length}::text[])`);
  }
  if (source) {
    params.push(String(source));
    clauses.push(`source = $${params.length}`);
  }
  if (hasChat) {
    params.push(String(chatGuid));
    clauses.push(`metadata->>'chatGuid' = $${params.length}`);
  }
  if (hasHandle) {
    params.push(String(handle));
    clauses.push(`metadata->>'handle' = $${params.length}`);
  }

  const result = await query(
    `DELETE FROM human_activity_events WHERE ${clauses.join(' AND ')}`,
    params,
  );
  const deleted = result.rowCount || 0;
  if (deleted > 0) {
    console.log(`🗓️  Deleted ${deleted} activity event(s)${source ? ` (source=${source})` : ''}`);
  }
  return { deleted };
}

/**
 * Aggregate conversations for a single source (iMessage, Signal, …) grouped by
 * `metadata.chatGuid`. Newest activity first. Optional free-text `q` filters
 * title/handle/summary. Cap defaults to 500 conversations.
 */
export async function listConversations({ source, q, limit } = {}) {
  if (!source) return [];
  await ensureReady();
  const params = [String(source)];
  const clauses = [`source = $1`];
  if (q != null && String(q).trim()) {
    params.push(`%${String(q).trim().toLowerCase()}%`);
    clauses.push(`(
      LOWER(COALESCE(title, '')) LIKE $${params.length}
      OR LOWER(COALESCE(summary, '')) LIKE $${params.length}
      OR LOWER(COALESCE(metadata->>'handle', '')) LIKE $${params.length}
      OR LOWER(COALESCE(metadata->>'chatGuid', '')) LIKE $${params.length}
    )`);
  }
  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  params.push(cap);
  const result = await query(
    `SELECT
       COALESCE(metadata->>'chatGuid', '') AS chat_guid,
       MAX(title) AS title,
       MAX(NULLIF(metadata->>'handle', '')) AS handle,
       COUNT(*)::int AS event_count,
       MIN(happened_at) AS first_at,
       MAX(happened_at) AS last_at,
       (array_agg(summary ORDER BY happened_at DESC)
          FILTER (WHERE summary IS NOT NULL AND summary <> ''))[1] AS last_summary
     FROM human_activity_events
     WHERE ${clauses.join(' AND ')}
     GROUP BY COALESCE(metadata->>'chatGuid', '')
     ORDER BY MAX(happened_at) DESC
     LIMIT $${params.length}`,
    params,
  );
  return result.rows.map((row) => ({
    chatGuid: row.chat_guid || '',
    title: row.title || row.handle || row.chat_guid || '(unknown)',
    handle: row.handle || null,
    eventCount: Number(row.event_count) || 0,
    firstAt: row.first_at instanceof Date ? row.first_at.toISOString() : row.first_at,
    lastAt: row.last_at instanceof Date ? row.last_at.toISOString() : row.last_at,
    lastSummary: row.last_summary || '',
  }));
}

/**
 * Source-level stats for a manager UI: total events, conversation count, date
 * range. Cheap aggregates over the machine-local activity store.
 */
export async function sourceStats(source) {
  if (!source) {
    return { source: null, eventCount: 0, conversationCount: 0, earliestAt: null, latestAt: null };
  }
  await ensureReady();
  const result = await query(
    `SELECT
       COUNT(*)::int AS event_count,
       COUNT(DISTINCT COALESCE(metadata->>'chatGuid', ''))::int AS conversation_count,
       MIN(happened_at) AS earliest_at,
       MAX(happened_at) AS latest_at
     FROM human_activity_events
     WHERE source = $1`,
    [String(source)],
  );
  const row = result.rows[0] || {};
  return {
    source: String(source),
    eventCount: Number(row.event_count) || 0,
    conversationCount: Number(row.conversation_count) || 0,
    earliestAt: row.earliest_at instanceof Date ? row.earliest_at.toISOString() : (row.earliest_at || null),
    latestAt: row.latest_at instanceof Date ? row.latest_at.toISOString() : (row.latest_at || null),
  };
}

// Day view: all events on a local calendar day plus an hourly histogram and
// source/kind tallies. `date` defaults to today in the user's timezone.
export async function getDaySummary({ date } = {}) {
  const timezone = await getUserTimezone();
  // `today` is computed in the USER's configured timezone (not the browser's) and
  // returned so the client can default the bare /timeline route and gate its
  // Today/next-day controls on the server's notion of the current day.
  const today = todayInTimezone(timezone);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : today;
  const range = localDayRangeUtc(day, timezone);
  if (!range) return { date: day, today, timezone, events: [], histogram: hourlyHistogram([], timezone), counts: summarizeCounts([]) };
  const events = await listEvents({ from: range.start.toISOString(), to: range.end.toISOString(), limit: 2000 });
  // listEvents returns newest-first; a day view reads better oldest-first.
  const ordered = [...events].reverse();
  return {
    date: day,
    today,
    timezone,
    events: ordered,
    histogram: hourlyHistogram(ordered, timezone),
    counts: summarizeCounts(ordered),
  };
}
