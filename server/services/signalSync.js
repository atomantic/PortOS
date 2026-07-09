/**
 * Signal Desktop ingestion (#2154) — read the local Signal Desktop chat database
 * and feed both the Tribe touchpoint log and the machine-local human-activity
 * timeline (#2150), reusing the iMessage phone-matching path (#2151).
 *
 * Signal is the **highest-fragility source** in the activity-tracking design: its
 * chat DB is SQLCipher-encrypted and the key handling changes across Signal
 * versions. Everything here is built for **graceful degradation** — an unknown
 * schema, a missing key, or a failed decryption surfaces an actionable sync-status
 * error and NEVER crashes or retry-loops.
 *
 * Design constraints (docs/plans/2026-07-04-human-activity-tracking.md):
 *
 * - **Zero new dependencies.** The SQLCipher-4 page decryption + Chromium
 *   safeStorage key-unwrap are implemented in pure `node:crypto`
 *   (`server/lib/signalCrypto.js`) — `node:sqlite` cannot open a SQLCipher file
 *   and shelling to a `sqlcipher` CLI would add a tool most machines lack. We
 *   decrypt to a plaintext temp copy, then read THAT with the built-in
 *   `node:sqlite` (readOnly). The macOS keychain read shells to the system
 *   `security` CLI (no dependency).
 * - **Never touch Signal's live file.** The DB is copied to a temp snapshot before
 *   decryption; the original `db.sqlite` is opened only for the `cp`.
 * - **Machine-local.** The incremental cursor lives in a `data/` JSON file — the DB
 *   and its rowids are per-machine. Derived events land in the already-machine-local
 *   `human_activity_events` table (excluded from peer sync).
 * - **LLM-free + idempotent.** Deterministic identity matching via `tribeMatch`;
 *   every event/touchpoint carries a stable dedupe key (`signal:<messageId>`) so
 *   re-syncs are no-ops.
 * - **Off by default.** Enabled only from Settings → Signal — reading the chat DB
 *   and the keychain entry needs user intent.
 *
 * The pure mappers (instant conversion, candidate mapping) are exported and
 * unit-tested with fixtures — no real Signal DB required.
 */
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expandHome, dataPath, atomicWrite, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { getUserTimezone } from '../lib/timezone.js';
import { identityFromHandle } from '../lib/tribeMatch.js';
import { decryptSqlcipherDatabase, decryptSafeStorageValue, isRawHexKey } from '../lib/signalCrypto.js';
import { shortSummary, localDayKey } from './humanActivity.js';
import { getSettings } from './settings.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default Signal Desktop locations on macOS. Overridable via env for tests /
// non-default layouts. `expandHome` resolves the leading `~/`.
const DEFAULT_SIGNAL_DIR = '~/Library/Application Support/Signal';
const CONFIG_REL = 'config.json';
const DB_REL = 'sql/db.sqlite';

// macOS keychain generic-password entry Electron safeStorage writes for Signal:
// service "<appName> Safe Storage", account "<appName>".
const KEYCHAIN_SERVICE = 'Signal Safe Storage';
const KEYCHAIN_ACCOUNT = 'Signal';

const STATE_FILE = 'signal-sync-state.json';

// Config defaults — surfaced via getSignalConfig(). Sync is OFF by default; the
// user opts in from Settings → Signal.
const DEFAULT_CONFIG = {
  enabled: false,
  intervalMinutes: 60,
};

// How many messages to pull per sync pass. Bounds memory + keeps a first sync on
// a huge history from blocking; the rowid cursor means the next pass resumes.
const SCAN_LIMIT = 5000;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function signalDir() {
  return expandHome(process.env.SIGNAL_DIR || DEFAULT_SIGNAL_DIR);
}
function configPath() {
  return process.env.SIGNAL_CONFIG_PATH || join(signalDir(), CONFIG_REL);
}
function dbPath() {
  return process.env.SIGNAL_DB_PATH || join(signalDir(), DB_REL);
}

// ---------------------------------------------------------------------------
// Pure mappers (exported for unit tests — no DB, no filesystem, no side effects)
// ---------------------------------------------------------------------------

/**
 * Convert a Signal millisecond-epoch timestamp (`sent_at` / `received_at`) to a
 * JS Date, or `null` when unusable. Signal stores whole milliseconds since the
 * Unix epoch, so no Apple-epoch offset math is needed (unlike iMessage).
 */
export function signalTimestampToDate(value) {
  if (value == null) return null;
  const n = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Map a Signal message record to a `type` we ingest, or `null` to skip. Only
 * real person-to-person messages become activity — Signal's `messages.type`
 * also carries `call-history`, `group-v2-change`, `verified-change`, etc.
 */
export function signalActivityKind(type, isFromMe) {
  if (type === 'outgoing') return 'message.sent';
  if (type === 'incoming') return 'message.received';
  // Some rows omit `type` but set an explicit direction — fall back to that.
  if (!type && typeof isFromMe === 'boolean') return isFromMe ? 'message.sent' : 'message.received';
  return null;
}

/**
 * Map one normalized Signal message record to a human-activity candidate, or
 * `null`. `msg`: { messageId, rowid, at: Date, text, type, isFromMe,
 * conversationId, conversationName, handles: string[] (e164s) }.
 * Dedupe key is `signal:<messageId>` (one activity event per message).
 */
export function signalActivityCandidate(msg) {
  if (!msg?.messageId || !(msg.at instanceof Date) || Number.isNaN(msg.at.getTime())) return null;
  const kind = signalActivityKind(msg.type, msg.isFromMe);
  if (!kind) return null;
  const isFromMe = kind === 'message.sent';
  const participants = (msg.handles || [])
    .map(identityFromHandle)
    .filter((p) => p && (p.email || p.phone));
  const counterpart = isFromMe ? '' : (msg.handles?.[0] || '');
  return {
    source: 'signal',
    accountId: null,
    kind,
    happenedAt: msg.at.toISOString(),
    title: msg.conversationName || counterpart || 'Signal',
    summary: shortSummary(msg.text || ''),
    participants,
    dedupeKey: `signal:${msg.messageId}`,
    metadata: {
      conversationId: msg.conversationId || null,
      handle: counterpart || null,
      rowid: msg.rowid ?? null,
    },
  };
}

export function signalActivityCandidates(messages = []) {
  return (messages || []).map(signalActivityCandidate).filter(Boolean);
}

/**
 * Group message records into Tribe touchpoint candidates — one per (conversation,
 * local day) so a busy thread logs a single daily touchpoint per matched person.
 * Mirrors `imessageTouchpointCandidates`. Dedupe key is
 * `signal:<conversationId>:<localDay>` (mirrors the `imsg:`/`msg:` convention).
 */
export function signalTouchpointCandidates(messages = [], timezone) {
  const byKey = new Map();
  for (const msg of messages || []) {
    if (!(msg?.at instanceof Date) || Number.isNaN(msg.at.getTime())) continue;
    if (!msg.conversationId) continue;
    const day = localDayKey(msg.at, timezone);
    if (!day) continue;
    const key = `${msg.conversationId}\u0000${day}`;
    let entry = byKey.get(key);
    if (!entry) {
      entry = { conversationId: msg.conversationId, day, at: msg.at, name: msg.conversationName || '', handles: new Set() };
      byKey.set(key, entry);
    }
    for (const h of msg.handles || []) if (h) entry.handles.add(h);
    if (msg.at > entry.at) entry.at = msg.at;
  }
  const out = [];
  for (const entry of byKey.values()) {
    const identities = [...entry.handles]
      .map(identityFromHandle)
      .filter((p) => p && (p.email || p.phone));
    if (identities.length === 0) continue;
    out.push({
      identities,
      source: 'signal',
      happenedAt: entry.at.toISOString(),
      channel: 'Signal',
      summary: entry.name || 'Signal conversation',
      dedupeKey: `signal:${entry.conversationId}:${entry.day}`,
      metadata: { conversationId: entry.conversationId, day: entry.day },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Config + machine-local cursor state
// ---------------------------------------------------------------------------

export async function getSignalConfig() {
  const settings = await getSettings().catch(() => ({}));
  const c = settings?.signal || {};
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

// Machine-local incremental cursor. NOT federated — the Signal DB and its rowids
// are per-machine, so this state must never sync to a peer.
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
// Key retrieval (side-effecting: reads config.json + shells to the keychain).
// Runs outside the request lifecycle, so try/catch is sanctioned — a native
// error must not crash the process; we return a structured report instead.
// ---------------------------------------------------------------------------

// Read the "Signal Safe Storage" keychain password via the system `security`
// CLI (execFile — no shell, no injection surface). Returns the password string
// or throws (caller maps to a graceful report).
async function readKeychainPassword() {
  if (process.env.SIGNAL_KEYCHAIN_PASSWORD) return process.env.SIGNAL_KEYCHAIN_PASSWORD; // test hook
  const { stdout } = await execFileAsync('security', [
    'find-generic-password', '-w', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT,
  ], { timeout: 15000 });
  const pw = String(stdout || '').replace(/\n$/, '');
  if (!pw) throw new Error('Keychain returned an empty Signal Safe Storage password');
  return pw;
}

/**
 * Resolve the SQLCipher DB key (64-hex-char string) from Signal's config.json.
 * Handles both the legacy plaintext `key` and the modern safeStorage-wrapped
 * `encryptedKey` (Signal ≥6.2). Returns `{ ok, key }` or `{ ok:false, error,
 * remediation }` — never throws.
 */
export async function resolveDbKey() {
  const cfgPath = configPath();
  const raw = await tryReadFile(cfgPath);
  if (raw == null) {
    return {
      ok: false,
      error: `Signal config not found at ${cfgPath}`,
      remediation: 'Signal Desktop does not appear to be installed for this user (no config.json).',
    };
  }
  const cfg = safeJSONParse(raw, null, { allowArray: false });
  if (!cfg || typeof cfg !== 'object') {
    return { ok: false, error: `Could not parse ${cfgPath}`, remediation: 'Signal config.json is malformed.' };
  }

  // Legacy plaintext key.
  if (typeof cfg.key === 'string' && cfg.key.trim()) {
    const key = cfg.key.trim();
    if (!isRawHexKey(key)) {
      return { ok: false, error: 'Signal config.json `key` is not a 64-hex-char SQLCipher key', remediation: 'Unrecognized Signal key format — this Signal version is not yet supported.' };
    }
    return { ok: true, key, source: 'plaintext' };
  }

  // Modern safeStorage-wrapped key.
  if (typeof cfg.encryptedKey === 'string' && cfg.encryptedKey.trim()) {
    let password;
    try {
      password = await readKeychainPassword();
    } catch (err) {
      return {
        ok: false,
        error: `Could not read the Signal Safe Storage keychain entry: ${err?.message || err}`,
        remediation: 'Grant the process running PortOS access to the "Signal Safe Storage" keychain item (approve the keychain prompt), then retry. On PM2, the daemon must run under your login session.',
      };
    }
    const encrypted = Buffer.from(cfg.encryptedKey.trim(), 'hex');
    const decrypted = decryptSafeStorageValue(encrypted, password);
    if (!decrypted.ok) {
      return { ok: false, error: `Signal key unwrap failed: ${decrypted.error}`, remediation: 'Signal key decryption failed — the keychain password may be wrong or this Signal version uses an unsupported scheme.' };
    }
    const key = decrypted.plaintext.toString('utf8').trim();
    if (!isRawHexKey(key)) {
      return { ok: false, error: 'Unwrapped Signal key is not a 64-hex-char SQLCipher key', remediation: 'Unrecognized Signal key format — this Signal version is not yet supported.' };
    }
    return { ok: true, key, source: 'safeStorage' };
  }

  return { ok: false, error: 'Signal config.json has neither `key` nor `encryptedKey`', remediation: 'This Signal version stores its key in an unsupported way.' };
}

// ---------------------------------------------------------------------------
// DB access — copy → decrypt → open plaintext with node:sqlite (readOnly).
// ---------------------------------------------------------------------------

// Copy the live DB to a temp snapshot, decrypt it to a sibling plaintext file,
// and return both paths for cleanup. Never touches Signal's live file beyond the
// read for `cp`. Returns { ok, plaintextPath, tmpDir } or an error report.
async function openDecryptedSnapshot(key) {
  const src = dbPath();
  try { statSync(src); } catch (err) {
    const missing = err?.code === 'ENOENT';
    return {
      ok: false,
      error: missing ? `Signal database not found at ${src}` : `Cannot access ${src}: ${err?.message || err}`,
      remediation: missing ? 'Signal Desktop has no chat database yet (never opened, or a different profile).' : 'Could not read the Signal database file — check file permissions for the process running PortOS.',
    };
  }
  const tmp = await mkdtemp(join(tmpdir(), 'portos-signal-'));
  const encPath = join(tmp, 'db.enc.sqlite');
  const plainPath = join(tmp, 'db.plain.sqlite');
  await copyFile(src, encPath);
  const encBuf = await tryReadFile(encPath, { encoding: null });
  if (!encBuf || !encBuf.length) {
    await rm(tmp, { recursive: true, force: true });
    return { ok: false, error: 'Signal database snapshot is empty', remediation: 'The Signal database copy was empty — try again with Signal closed.' };
  }
  const decrypted = decryptSqlcipherDatabase(encBuf, key, { verify: 'first' });
  if (!decrypted.ok) {
    await rm(tmp, { recursive: true, force: true });
    return {
      ok: false,
      error: `Signal database decryption failed: ${decrypted.error}`,
      remediation: 'Signal database decryption failed — the key or SQLCipher format may have changed in this Signal version (not yet supported).',
    };
  }
  await writeFile(plainPath, decrypted.plaintext);
  return { ok: true, plaintextPath: plainPath, tmpDir: tmp };
}

// Confirm the decrypted DB carries the Signal schema we understand. On an
// unexpected shape return a structured error so the UI reports "unsupported
// version" instead of throwing mid-query.
function verifySchema(db) {
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name),
  );
  for (const t of ['messages', 'conversations']) {
    if (!tables.has(t)) return { ok: false, error: `Signal schema missing expected table "${t}"` };
  }
  const cols = new Set(db.prepare('PRAGMA table_info(messages)').all().map((r) => r.name));
  for (const c of ['id', 'conversationId', 'type', 'sent_at', 'received_at', 'body']) {
    if (!cols.has(c)) return { ok: false, error: `Signal "messages" table missing expected column "${c}"` };
  }
  return { ok: true };
}

// Read a batch of messages after `cursorRowid` plus the conversation→e164 map.
// Returns normalized message records (the shape the pure mappers consume) and the
// max rowid seen. Kept separate from runSync so the SQL boundary is small.
function readMessages(db, cursorRowid, limit) {
  // Conversation metadata: private conversations carry an `e164` (phone) we can
  // match to a tracked person; group rows don't (their members live in JSON).
  const convById = new Map();
  for (const r of db.prepare('SELECT id, e164, type, name, profileName FROM conversations').all()) {
    if (!r.id) continue;
    convById.set(r.id, { e164: r.e164 || '', type: r.type || '', name: r.name || r.profileName || '' });
  }

  const rows = db.prepare(
    `SELECT m.rowid AS rowid, m.id AS id, m.conversationId AS conversation_id,
            m.type AS type, m.sent_at AS sent_at, m.received_at AS received_at, m.body AS body
       FROM messages m
      WHERE m.rowid > ?
      ORDER BY m.rowid ASC
      LIMIT ?`,
  ).all(cursorRowid, limit);

  let maxRowid = cursorRowid;
  const messages = [];
  for (const row of rows) {
    const rowid = Number(row.rowid);
    if (rowid > maxRowid) maxRowid = rowid;
    const at = signalTimestampToDate(row.sent_at) || signalTimestampToDate(row.received_at);
    if (!at) continue;
    const conv = row.conversation_id ? convById.get(row.conversation_id) : null;
    const handles = conv?.e164 ? [conv.e164] : [];
    messages.push({
      messageId: row.id,
      rowid,
      at,
      text: row.body || '',
      type: row.type || '',
      conversationId: row.conversation_id || null,
      conversationName: conv?.name || '',
      handles,
    });
  }
  return { messages, maxRowid, scanned: rows.length };
}

/**
 * Attempt to resolve the key + open the decrypted DB and probe the schema.
 * Returns a structured report — never throws — so the setup-check route can
 * render an actionable error (missing install, key failure, unsupported schema).
 */
export async function checkSetup() {
  const keyResult = await resolveDbKey();
  if (!keyResult.ok) {
    return { ok: false, dbPath: dbPath(), error: keyResult.error, remediation: keyResult.remediation };
  }
  const snapshot = await openDecryptedSnapshot(keyResult.key);
  if (!snapshot.ok) {
    return { ok: false, dbPath: dbPath(), error: snapshot.error, remediation: snapshot.remediation };
  }
  let db;
  try {
    db = new DatabaseSync(snapshot.plaintextPath, { readOnly: true });
    const schema = verifySchema(db);
    if (!schema.ok) {
      return { ok: false, dbPath: dbPath(), error: schema.error, remediation: 'This Signal database schema is not yet supported.' };
    }
    const row = db.prepare('SELECT COUNT(*) AS n FROM messages').get();
    return { ok: true, dbPath: dbPath(), keySource: keyResult.source, messageCount: Number(row?.n || 0) };
  } catch (err) {
    return { ok: false, dbPath: dbPath(), error: err?.message || 'Failed to open decrypted Signal DB', remediation: 'The decrypted Signal database could not be opened — the SQLCipher format may have changed.' };
  } finally {
    try { db?.close(); } catch { /* already closed / never opened */ }
    await rm(snapshot.tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Run one incremental sync pass: resolve the key, decrypt a DB snapshot, read new
 * messages after the stored rowid cursor, record activity events + Tribe
 * touchpoints, and advance the cursor. Returns a summary. Safe to call repeatedly
 * — dedupe keys make re-ingestion a no-op. Runs outside the request lifecycle
 * (scheduler / explicit endpoint), so every failure is try/catch-guarded and
 * returns an error report instead of throwing.
 *
 * Re-entrancy guarded: a manual "Sync now" overlapping a scheduler tick would
 * double-read the same cursor — so concurrent callers share the in-flight pass.
 */
let syncInFlight = null;
export async function runSync() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = doRunSync().finally(() => { syncInFlight = null; });
  return syncInFlight;
}

async function doRunSync() {
  const state = await readSyncState();

  const keyResult = await resolveDbKey();
  if (!keyResult.ok) {
    console.error(`❌ Signal sync: ${keyResult.error}`);
    return { ok: false, error: keyResult.error, remediation: keyResult.remediation };
  }

  const snapshot = await openDecryptedSnapshot(keyResult.key);
  if (!snapshot.ok) {
    console.error(`❌ Signal sync: ${snapshot.error}`);
    return { ok: false, error: snapshot.error, remediation: snapshot.remediation };
  }

  let db;
  let batch;
  try {
    db = new DatabaseSync(snapshot.plaintextPath, { readOnly: true });
    const schema = verifySchema(db);
    if (!schema.ok) {
      console.error(`❌ Signal sync: ${schema.error}`);
      return { ok: false, error: schema.error, remediation: 'This Signal database schema is not yet supported.' };
    }
    batch = readMessages(db, state.cursorRowid, SCAN_LIMIT);
  } catch (err) {
    console.error(`❌ Signal sync failed reading DB: ${err?.message || err}`);
    return { ok: false, error: err?.message || 'Failed to read Signal DB' };
  } finally {
    try { db?.close(); } catch { /* noop */ }
    await rm(snapshot.tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const timezone = await getUserTimezone();
  const { recordEvents } = await import('./humanActivity.js');
  const tribe = await import('./tribe.js');

  const activityCandidates = signalActivityCandidates(batch.messages);
  const touchpointCandidates = signalTouchpointCandidates(batch.messages, timezone);

  // Persistence failures must NOT advance the cursor: the dedupe keys make
  // re-processing the batch a harmless no-op, but skipping past unpersisted
  // messages loses them permanently. Hold the cursor so the batch retries.
  let persistFailed = false;
  const activityResult = await recordEvents(activityCandidates).catch((err) => {
    console.error(`❌ Signal activity record failed: ${err?.message || err}`);
    persistFailed = true;
    return { recorded: 0, skipped: activityCandidates.length };
  });
  const touchpointResult = await tribe.autoLogTouchpoints(touchpointCandidates).catch((err) => {
    console.error(`❌ Signal touchpoint log failed: ${err?.message || err}`);
    persistFailed = true;
    return { created: 0, matched: 0 };
  });

  const nextCursor = persistFailed ? state.cursorRowid : batch.maxRowid;
  const result = {
    ok: !persistFailed,
    ...(persistFailed ? { error: 'Persistence failed — cursor held so the batch retries next sync' } : {}),
    scanned: batch.scanned,
    recorded: activityResult.recorded,
    touchpointsCreated: touchpointResult.created,
    touchpointsMatched: touchpointResult.matched,
    cursorRowid: nextCursor,
    keySource: keyResult.source,
    hasMore: batch.scanned === SCAN_LIMIT,
  };
  await writeSyncState({ cursorRowid: nextCursor, lastRunAt: new Date().toISOString(), lastResult: result });
  console.log(`🔒 Signal sync: scanned ${result.scanned}, recorded ${result.recorded} event(s), ${result.touchpointsCreated} touchpoint(s), cursor→${result.cursorRowid}${result.hasMore ? ' (more remaining)' : ''}${persistFailed ? ' — PERSIST FAILED, cursor held' : ''}`);
  return result;
}

// Status for the settings UI: config + cursor state (no DB open / key read).
export async function getStatus() {
  const [config, state] = await Promise.all([getSignalConfig(), readSyncState()]);
  return { config, state };
}
