/**
 * iMessage ingestion (#2151) — read the local macOS Messages database
 * (`~/Library/Messages/chat.db`) and feed both the Tribe touchpoint log and the
 * machine-local human-activity timeline (#2150).
 *
 * Design constraints (see docs/plans/2026-07-04-human-activity-tracking.md):
 *
 * - **Zero new dependencies.** SQLite reads use Node's built-in `node:sqlite`
 *   (Node ≥22). The DB is opened `readOnly: true` — we NEVER write to Apple's DB.
 * - **Machine-local.** The incremental cursor lives in a `data/` JSON file, not a
 *   federated store — chat.db is per-machine. Derived events land in the
 *   already-machine-local `human_activity_events` table.
 * - **LLM-free + idempotent.** Deterministic identity matching via `tribeMatch`;
 *   every event/touchpoint carries a stable dedupe key so re-syncs are no-ops.
 * - **Best-effort text.** When `message.text` is NULL, the body is extracted from
 *   the archived `attributedBody` typedstream; a parse failure is counted and
 *   skipped, never fatal.
 * - **Full Disk Access.** Opening chat.db requires the node/PM2 process to have
 *   macOS Full Disk Access; `checkSetup()` reports an actionable error when blocked.
 *
 * The pure mappers (epoch conversion, typedstream decode, candidate mapping) are
 * exported and unit-tested with fixtures — no real chat.db required.
 */
import { DatabaseSync } from 'node:sqlite';

import { expandHome, dataPath, atomicWrite, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { getUserTimezone } from '../lib/timezone.js';
import { identityFromHandle } from '../lib/tribeMatch.js';
import { shortSummary, localDayKey } from './humanActivity.js';
import { getSettings } from './settings.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Milliseconds between the Unix epoch (1970-01-01) and the Apple/Cocoa epoch
// (2001-01-01 UTC). `message.date` is measured from the Apple epoch.
const APPLE_EPOCH_OFFSET_MS = 978307200000;

// The default location of the macOS Messages database. Overridable via env for
// tests / non-default home layouts. `expandHome` resolves the leading `~/`.
const DEFAULT_CHAT_DB = '~/Library/Messages/chat.db';

const STATE_FILE = 'imessage-sync-state.json';

// Config defaults — surfaced via getImessageConfig(). Sync is OFF by default;
// the user opts in from Settings → iMessage. Reading chat.db needs Full Disk
// Access, so we never enable it silently.
const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: 30,
};

// How many messages to pull per sync pass. Bounds memory + keeps a first sync on
// a huge history from blocking; the ROWID cursor means the next pass resumes.
const SCAN_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no DB, no filesystem, no side effects)
// ---------------------------------------------------------------------------

/**
 * Convert an Apple `message.date` value to a JS Date, or `null` when unusable.
 *
 * Modern macOS (10.13+) stores nanoseconds since the Apple epoch; legacy stores
 * whole seconds. A post-2001 nanosecond value is ~1e17+, a seconds value is
 * ~1e8–1e9, so a `1e12` threshold cleanly separates the two. (Sub-millisecond
 * precision is irrelevant here and Number is plenty accurate at second scale.)
 */
export function appleDateToDate(value) {
  if (value == null) return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  const seconds = Math.abs(n) >= 1e12 ? n / 1e9 : n;
  const ms = APPLE_EPOCH_OFFSET_MS + seconds * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Best-effort plain-text extraction from an archived `attributedBody` typedstream
 * (the `streamtyped` NSAttributedString blob Messages stores when `text` is NULL).
 * Returns the message string, or `null` when the blob can't be parsed — the caller
 * counts a decode failure and skips the row rather than erroring the whole sync.
 *
 * Heuristic (matches the well-known imessage-exporter approach): locate the
 * `NSString` class marker, then the length-prefixed UTF-8 payload after the `+`
 * (0x2b) start-of-value marker. Lengths use typedstream's varint-ish prefix:
 * a byte < 0x80 is the length; 0x81 = uint16-LE follows; 0x82 = uint32-LE follows.
 */
export function decodeAttributedBody(buffer) {
  if (!buffer || !buffer.length) return null;
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const marker = buf.indexOf('NSString', 0, 'latin1');
  if (marker === -1) return null;
  let i = buf.indexOf(0x2b, marker); // '+' — start-of-value marker
  if (i === -1) return null;
  i += 1;
  if (i >= buf.length) return null;
  let len = buf[i];
  i += 1;
  if (len === 0x81) {
    if (i + 1 >= buf.length) return null;
    len = buf[i] | (buf[i + 1] << 8);
    i += 2;
  } else if (len === 0x82) {
    if (i + 3 >= buf.length) return null;
    len = buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] * 0x1000000);
    i += 4;
  } else if (len > 0x80) {
    return null; // an encoding we don't handle — best-effort skip
  }
  if (len <= 0 || i + len > buf.length) return null;
  const text = buf.toString('utf8', i, i + len).trim();
  return text || null;
}

/**
 * Resolve a normalized message record's body text: the plain `text` column when
 * present, else a best-effort decode of `attributedBody`. Returns
 * `{ text, decodeFailed }` — `decodeFailed` is true only when `text` was NULL AND
 * the attributedBody blob existed but could not be parsed (so the caller can tally
 * skips without treating an empty-body message as a failure).
 */
export function resolveMessageText(row) {
  if (row?.text != null && String(row.text).length > 0) {
    return { text: String(row.text), decodeFailed: false };
  }
  if (row?.attributedBody && row.attributedBody.length) {
    const decoded = decodeAttributedBody(row.attributedBody);
    if (decoded != null) return { text: decoded, decodeFailed: false };
    return { text: '', decodeFailed: true };
  }
  return { text: '', decodeFailed: false };
}

/**
 * Map one normalized message record to a human-activity candidate, or `null`.
 * `msg`: { guid, rowid, at: Date, text, isFromMe, handle, chatGuid, chatName,
 *          service, participants: string[] }
 * Dedupe key is `imsg:<message.guid>` (one activity event per message).
 */
export function imessageActivityCandidate(msg) {
  if (!msg?.guid || !(msg.at instanceof Date) || Number.isNaN(msg.at.getTime())) return null;
  const kind = msg.isFromMe ? 'message.sent' : 'message.received';
  const counterpart = msg.isFromMe ? '' : (msg.handle || '');
  const participants = (msg.participants || [])
    .map(identityFromHandle)
    .filter((p) => p && (p.email || p.phone));
  return {
    source: 'imessage',
    accountId: null,
    kind,
    happenedAt: msg.at.toISOString(),
    title: msg.chatName || counterpart || 'iMessage',
    summary: shortSummary(msg.text || ''),
    participants,
    dedupeKey: `imsg:${msg.guid}`,
    metadata: {
      chatGuid: msg.chatGuid || null,
      service: msg.service || null,
      handle: counterpart || null,
      rowid: msg.rowid ?? null,
    },
  };
}

export function imessageActivityCandidates(messages = []) {
  return (messages || []).map(imessageActivityCandidate).filter(Boolean);
}

/**
 * Group message records into Tribe touchpoint candidates — one per (chat, local
 * day) so a busy thread logs a single daily touchpoint per matched person. Each
 * candidate's `identities` are the chat's participant handles (classified as
 * email-or-phone), matched deterministically to tracked people downstream.
 * Dedupe key is `imsg:<chatGuid>:<localDay>` (mirrors the `msg:` convention).
 */
export function imessageTouchpointCandidates(messages = [], timezone) {
  const byKey = new Map();
  for (const msg of messages || []) {
    if (!(msg?.at instanceof Date) || Number.isNaN(msg.at.getTime())) continue;
    if (!msg.chatGuid) continue;
    const day = localDayKey(msg.at, timezone);
    if (!day) continue;
    const key = `${msg.chatGuid} ${day}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { chatGuid: msg.chatGuid, day, at: msg.at, name: msg.chatName || '', handles: new Set() };
      byKey.set(key, entry);
    }
    for (const h of msg.participants || []) if (h) entry.handles.add(h);
    if (msg.at > entry.at) entry.at = msg.at; // latest instant in the day
  }
  const out = [];
  for (const entry of byKey.values()) {
    const identities = [...entry.handles]
      .map(identityFromHandle)
      .filter((p) => p && (p.email || p.phone));
    if (identities.length === 0) continue;
    out.push({
      identities,
      source: 'imessage',
      happenedAt: entry.at.toISOString(),
      channel: 'iMessage',
      summary: entry.name || 'iMessage conversation',
      dedupeKey: `imsg:${entry.chatGuid}:${entry.day}`,
      metadata: { chatGuid: entry.chatGuid, day: entry.day },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config + machine-local cursor state
// ---------------------------------------------------------------------------

export async function getImessageConfig() {
  const settings = await getSettings().catch(() => ({}));
  const c = settings?.imessage || {};
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : DEFAULT_CONFIG.enabled,
    intervalMinutes: Number.isFinite(c.intervalMinutes) && c.intervalMinutes >= 1
      ? Math.floor(c.intervalMinutes)
      : DEFAULT_CONFIG.intervalMinutes,
  };
}

function stateFilePath() {
  return dataPath(STATE_FILE);
}

// Machine-local incremental cursor. NOT federated — chat.db and its ROWIDs are
// per-machine, so this state must never sync to a peer.
export async function readSyncState() {
  const raw = await tryReadFile(stateFilePath());
  const parsed = raw ? safeJSONParse(raw, null, { allowArray: false }) : null;
  return {
    cursorRowid: Number.isFinite(parsed?.cursorRowid) ? parsed.cursorRowid : 0,
    lastRunAt: parsed?.lastRunAt || null,
    lastResult: parsed?.lastResult || null,
  };
}

async function writeSyncState(state) {
  await atomicWrite(stateFilePath(), JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// chat.db access (side-effecting — try/catch is sanctioned here: this runs
// outside the Express request lifecycle and a native open error must not crash
// the process). We open readOnly and never mutate Apple's database.
// ---------------------------------------------------------------------------

export function chatDbPath() {
  return expandHome(process.env.IMESSAGE_CHAT_DB || DEFAULT_CHAT_DB);
}

// Classify a chat.db open failure so the UI can surface an actionable message.
// A macOS sandbox / TCC denial surfaces as EPERM/EACCES or SQLite "unable to
// open database file" (SQLITE_CANTOPEN) — all of which mean Full Disk Access is
// missing for the running process.
function isFullDiskAccessError(err) {
  const msg = String(err?.message || '').toLowerCase();
  return err?.code === 'EACCES'
    || err?.code === 'EPERM'
    || msg.includes('unable to open')
    || msg.includes('not authorized')
    || msg.includes('operation not permitted');
}

const FDA_REMEDIATION = 'Grant Full Disk Access to the process running PortOS (node or the PM2 daemon): System Settings → Privacy & Security → Full Disk Access → enable your terminal / node / pm2, then restart PortOS.';

/**
 * Attempt to open chat.db read-only and run a trivial probe query. Returns a
 * structured report — never throws — so the setup-check route can render an
 * actionable Full Disk Access error when blocked.
 */
export async function checkSetup() {
  const path = chatDbPath();
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const row = db.prepare('SELECT COUNT(*) AS n FROM message').get();
    return { ok: true, dbPath: path, messageCount: Number(row?.n || 0) };
  } catch (err) {
    const fullDiskAccessRequired = isFullDiskAccessError(err);
    return {
      ok: false,
      dbPath: path,
      error: err?.message || 'Failed to open chat.db',
      fullDiskAccessRequired,
      remediation: fullDiskAccessRequired ? FDA_REMEDIATION : `Could not read ${path}: ${err?.message || 'unknown error'}`,
    };
  } finally {
    try { db?.close(); } catch { /* already closed / never opened */ }
  }
}

// Read a batch of messages after `cursorRowid` plus the chat→participants map.
// Returns normalized message records (the shape the pure mappers consume) and the
// max ROWID seen. Kept separate from runSync so the SQL boundary is small and the
// mapping stays pure/testable.
function readMessages(db, cursorRowid, limit) {
  const partRows = db.prepare(
    `SELECT c.guid AS chat_guid, h.id AS handle
       FROM chat c
       JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
       JOIN handle h ON h.ROWID = chj.handle_id`,
  ).all();
  const participantsByChat = new Map();
  for (const r of partRows) {
    if (!r.chat_guid || !r.handle) continue;
    const list = participantsByChat.get(r.chat_guid) || [];
    list.push(r.handle);
    participantsByChat.set(r.chat_guid, list);
  }

  // `m.date` is nanoseconds since 2001 on modern macOS — a value that exceeds
  // Number.MAX_SAFE_INTEGER, which node:sqlite REFUSES to return as a JS number
  // (throws ERR_OUT_OF_RANGE). CAST it to TEXT so it comes back as a decimal
  // string; appleDateToDate parses it (second-scale precision is all we need).
  const rows = db.prepare(
    `SELECT m.ROWID AS rowid, m.guid, CAST(m.date AS TEXT) AS date, m.text, m.attributedBody,
            m.is_from_me AS is_from_me, m.service,
            h.id AS handle,
            c.guid AS chat_guid, c.display_name AS chat_name, c.chat_identifier
       FROM message m
       JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
       JOIN chat c ON c.ROWID = cmj.chat_id
       LEFT JOIN handle h ON h.ROWID = m.handle_id
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
      LIMIT ?`,
  ).all(cursorRowid, limit);

  let maxRowid = cursorRowid;
  let decodeFailures = 0;
  const messages = [];
  for (const row of rows) {
    const rowid = Number(row.rowid);
    if (rowid > maxRowid) maxRowid = rowid;
    const at = appleDateToDate(row.date);
    if (!at) continue;
    const { text, decodeFailed } = resolveMessageText(row);
    if (decodeFailed) decodeFailures += 1;
    const chatGuid = row.chat_guid || null;
    const participants = chatGuid ? (participantsByChat.get(chatGuid) || []) : [];
    // Fall back to the message sender's handle when the chat has no join rows.
    if (participants.length === 0 && row.handle) participants.push(row.handle);
    messages.push({
      guid: row.guid,
      rowid,
      at,
      text,
      isFromMe: Number(row.is_from_me) === 1,
      handle: row.handle || '',
      chatGuid,
      chatName: row.chat_name || row.chat_identifier || '',
      service: row.service || null,
      participants,
    });
  }
  return { messages, maxRowid, scanned: rows.length, decodeFailures };
}

/**
 * Run one incremental sync pass: read new messages after the stored ROWID cursor,
 * record activity events + Tribe touchpoints, and advance the cursor. Returns a
 * summary. Safe to call repeatedly — dedupe keys make re-ingestion a no-op. This
 * runs outside the request lifecycle (scheduler / explicit endpoint), so the
 * chat.db open is try/catch-guarded and returns an error report instead of throwing.
 */
export async function runSync() {
  const state = await readSyncState();
  const path = chatDbPath();
  let db;
  let batch;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    batch = readMessages(db, state.cursorRowid, SCAN_LIMIT);
  } catch (err) {
    const fullDiskAccessRequired = isFullDiskAccessError(err);
    console.error(`❌ iMessage sync failed to open chat.db: ${err?.message || err}`);
    return {
      ok: false,
      error: err?.message || 'Failed to open chat.db',
      fullDiskAccessRequired,
      remediation: fullDiskAccessRequired ? FDA_REMEDIATION : undefined,
    };
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }

  const timezone = await getUserTimezone();
  const { recordEvents } = await import('./humanActivity.js');
  const tribe = await import('./tribe.js');

  const activityCandidates = imessageActivityCandidates(batch.messages);
  const touchpointCandidates = imessageTouchpointCandidates(batch.messages, timezone);

  const activityResult = await recordEvents(activityCandidates).catch((err) => {
    console.error(`❌ iMessage activity record failed: ${err?.message || err}`);
    return { recorded: 0, skipped: activityCandidates.length };
  });
  const touchpointResult = await tribe.autoLogTouchpoints(touchpointCandidates).catch((err) => {
    console.error(`❌ iMessage touchpoint log failed: ${err?.message || err}`);
    return { created: 0, matched: 0 };
  });

  const result = {
    ok: true,
    scanned: batch.scanned,
    recorded: activityResult.recorded,
    touchpointsCreated: touchpointResult.created,
    touchpointsMatched: touchpointResult.matched,
    decodeFailures: batch.decodeFailures,
    cursorRowid: batch.maxRowid,
  };
  await writeSyncState({ cursorRowid: batch.maxRowid, lastRunAt: new Date().toISOString(), lastResult: result });
  console.log(`💬 iMessage sync: scanned ${result.scanned}, recorded ${result.recorded} event(s), ${result.touchpointsCreated} touchpoint(s), ${result.decodeFailures} decode-skip(s), cursor→${result.cursorRowid}`);
  return result;
}

// Status for the settings UI: config + cursor state (no chat.db open).
export async function getStatus() {
  const [config, state] = await Promise.all([getImessageConfig(), readSyncState()]);
  return { config, state };
}
