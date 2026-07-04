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

// UTC [start, end) instants that bound a local calendar day (YYYY-MM-DD) in the
// given timezone. Offset is sampled at local midnight; a DST transition mid-day
// shifts the far boundary by ≤1h, which is acceptable for day bucketing.
export function localDayRangeUtc(dateStr, timezone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return null;
  const [, y, mo, d] = m.map(Number);
  const approxUtc = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  const offset = getUtcOffsetMs(approxUtc, timezone);
  const start = new Date(approxUtc.getTime() - offset);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
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
      },
    });
  }
  return out;
}

// Map calendar events to activity candidates. Only events that have already
// happened (end/start <= now) and weren't declined/cancelled count as activity,
// mirroring the tribe touchpoint gate.
export function calendarActivityCandidates(account, events = [], now = Date.now()) {
  const accountId = account?.id || null;
  const out = [];
  for (const event of events || []) {
    if (event?.isCancelled || event?.myStatus === 'declined') continue;
    const startedAt = event.startTime || event.endTime;
    if (!startedAt) continue;
    const completedAt = event.endTime || event.startTime;
    if (new Date(completedAt).getTime() > now) continue; // not finished yet
    const eventKey = event.externalId || event.id;
    if (!eventKey) continue;
    const start = new Date(event.startTime).getTime();
    const end = new Date(event.endTime).getTime();
    const durationS = Number.isFinite(start) && Number.isFinite(end) && end > start
      ? Math.round((end - start) / 1000)
      : null;
    out.push({
      source: 'calendar',
      accountId,
      kind: 'calendar.event',
      happenedAt: startedAt,
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
// containment operator. Newest first, capped by `limit` (default 500, max 2000).
export async function listEvents({ from, to, source, kind, personId, limit } = {}) {
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

// Day view: all events on a local calendar day plus an hourly histogram and
// source/kind tallies. `date` defaults to today in the user's timezone.
export async function getDaySummary({ date } = {}) {
  const timezone = await getUserTimezone();
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : todayInTimezone(timezone);
  const range = localDayRangeUtc(day, timezone);
  if (!range) return { date: day, timezone, events: [], histogram: hourlyHistogram([], timezone), counts: summarizeCounts([]) };
  const events = await listEvents({ from: range.start.toISOString(), to: range.end.toISOString(), limit: 2000 });
  // listEvents returns newest-first; a day view reads better oldest-first.
  const ordered = [...events].reverse();
  return {
    date: day,
    timezone,
    events: ordered,
    histogram: hourlyHistogram(ordered, timezone),
    counts: summarizeCounts(ordered),
  };
}
