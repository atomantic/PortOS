/**
 * iMessage activity manager (#2413) — PortOS-side browse / purge / blocklist
 * for events ingested from chat.db (#2151).
 *
 * Hard boundary: this module never opens Apple's Messages database. Deletes
 * remove rows from the machine-local `human_activity_events` table only.
 * Blocklisted handles are skipped on future syncs (see imessageSync.runSync).
 */
import { dataPath, atomicWrite, tryReadFile, safeJSONParse } from '../lib/fileUtils.js';
import { identityFromHandle, normalizeIdentifier, normalizePhone } from '../lib/tribeMatch.js';
import * as humanActivity from './humanActivity.js';
import { getStatus } from './imessageSync.js';

const SOURCE = 'imessage';
const BLOCKLIST_FILE = 'imessage-blocklist.json';

// ---------------------------------------------------------------------------
// chatKey encode/decode — URL-safe base64 of the raw chatGuid (Apple GUIDs
// contain `:` and `+` which are awkward in path segments).
// ---------------------------------------------------------------------------

// Empty chatGuid (orphan rows with no chat join) maps to a non-empty path
// segment so `/imessage/:chatKey` always has a param.
const EMPTY_CHAT_KEY = '_';

export function encodeChatKey(chatGuid) {
  const raw = chatGuid == null ? '' : String(chatGuid);
  if (!raw) return EMPTY_CHAT_KEY;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeChatKey(chatKey) {
  if (chatKey == null || chatKey === '') return null;
  if (String(chatKey) === EMPTY_CHAT_KEY) return '';
  try {
    return Buffer.from(String(chatKey), 'base64url').toString('utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Blocklist — machine-local, not federated (same locality as the sync cursor).
// Handles are stored as normalized match keys so +1 555 / 555-… / +1555… collide.
// ---------------------------------------------------------------------------

function blocklistPath() {
  return dataPath(BLOCKLIST_FILE);
}

/**
 * Stable match key for a raw handle (phone → E.164-ish, email → lowercased).
 * Empty string when the handle can't be classified.
 */
export function blocklistKey(handle) {
  const id = identityFromHandle(handle);
  if (id.phone) return id.phone;
  if (id.email) return id.email;
  // Fallback: trim + lower so free-form keys still dedupe case-insensitively.
  const raw = handle == null ? '' : String(handle).trim().toLowerCase();
  return raw;
}

export async function readBlocklist() {
  const raw = await tryReadFile(blocklistPath());
  const parsed = raw ? safeJSONParse(raw, null, { allowArray: false }) : null;
  const handles = Array.isArray(parsed?.handles)
    ? [...new Set(parsed.handles.map((h) => blocklistKey(h)).filter(Boolean))].sort()
    : [];
  return {
    handles,
    updatedAt: parsed?.updatedAt || null,
  };
}

async function writeBlocklist(handles) {
  const cleaned = [...new Set((handles || []).map((h) => blocklistKey(h)).filter(Boolean))].sort();
  const payload = { handles: cleaned, updatedAt: new Date().toISOString() };
  await atomicWrite(blocklistPath(), JSON.stringify(payload, null, 2));
  return payload;
}

export async function setBlocklist(handles) {
  return writeBlocklist(handles);
}

/**
 * Add one or more handles to the blocklist. When `purgeExisting` is true, also
 * deletes PortOS activity events whose metadata.handle matches (normalized).
 * Returns `{ handles, added, purged }`.
 */
export async function addToBlocklist(handles, { purgeExisting = false } = {}) {
  const incoming = (Array.isArray(handles) ? handles : [handles])
    .map((h) => blocklistKey(h))
    .filter(Boolean);
  const current = await readBlocklist();
  const before = new Set(current.handles);
  const next = new Set(current.handles);
  const added = [];
  for (const key of incoming) {
    if (!next.has(key)) {
      next.add(key);
      added.push(key);
    }
  }
  const saved = await writeBlocklist([...next]);
  let purged = 0;
  if (purgeExisting && added.length > 0) {
    // Events store the raw counterpart handle in metadata.handle; match via
    // the same normalization so a stored "+1 555…" still purges.
    for (const key of added.length ? added : incoming) {
      // Direct metadata match for the normalized form, plus common raw variants
      // are unlikely — also scan by listing is too heavy. Instead delete where
      // the stored handle normalizes to the key (SQL can't run JS, so we delete
      // by exact stored handle when it already equals the key, which is what
      // imessageSync writes for phone handles after chat.db).
      const r = await humanActivity.deleteEvents({ source: SOURCE, handle: key });
      purged += r.deleted;
    }
    // Also try un-normalized variants callers may have passed (raw phone).
    for (const raw of Array.isArray(handles) ? handles : [handles]) {
      const rawStr = raw == null ? '' : String(raw).trim();
      if (!rawStr) continue;
      if (blocklistKey(rawStr) && rawStr !== blocklistKey(rawStr)) {
        const r = await humanActivity.deleteEvents({ source: SOURCE, handle: rawStr });
        purged += r.deleted;
      }
    }
  }
  void before; // reserved for diagnostics
  return { ...saved, added, purged };
}

export async function removeFromBlocklist(handle) {
  const key = blocklistKey(handle);
  if (!key) return readBlocklist();
  const current = await readBlocklist();
  if (!current.handles.includes(key)) return current;
  return writeBlocklist(current.handles.filter((h) => h !== key));
}

/**
 * True when a raw message counterpart handle is on the blocklist.
 * Pure given a pre-loaded handle-key set (sync path loads once per pass).
 */
export function isHandleBlocked(handle, blockedKeys) {
  if (!blockedKeys || blockedKeys.size === 0) return false;
  const key = blocklistKey(handle);
  if (key && blockedKeys.has(key)) return true;
  // Also check participant-less from-me messages via empty key — never block empty.
  return false;
}

/**
 * Filter activity/touchpoint candidates whose counterpart handle is blocked.
 * For activity events: metadata.handle (empty for from-me → check participants).
 * For touchpoints: any identity in the candidate.
 */
export function filterBlockedActivityCandidates(candidates = [], blockedKeys) {
  if (!blockedKeys || blockedKeys.size === 0) return { kept: candidates || [], skipped: 0 };
  const kept = [];
  let skipped = 0;
  for (const c of candidates || []) {
    const handle = c?.metadata?.handle || '';
    if (handle && isHandleBlocked(handle, blockedKeys)) {
      skipped += 1;
      continue;
    }
    // Group chats / from-me: skip only when EVERY participant is blocked (rare);
    // if any participant is clean, keep — the user may still want the thread.
    const parts = Array.isArray(c?.participants) ? c.participants : [];
    if (!handle && parts.length > 0) {
      const allBlocked = parts.every((p) => {
        const key = p.phone || p.email || '';
        return key && blockedKeys.has(key);
      });
      if (allBlocked) {
        skipped += 1;
        continue;
      }
    }
    kept.push(c);
  }
  return { kept, skipped };
}

export function filterBlockedTouchpointCandidates(candidates = [], blockedKeys) {
  if (!blockedKeys || blockedKeys.size === 0) return { kept: candidates || [], skipped: 0 };
  const kept = [];
  let skipped = 0;
  for (const c of candidates || []) {
    const identities = Array.isArray(c?.identities) ? c.identities : [];
    if (identities.length === 0) {
      kept.push(c);
      continue;
    }
    // Drop the touchpoint only when every identity is blocked.
    const allBlocked = identities.every((id) => {
      const key = id.phone || id.email || '';
      return key && blockedKeys.has(key);
    });
    if (allBlocked) {
      skipped += 1;
      continue;
    }
    kept.push(c);
  }
  return { kept, skipped };
}

// ---------------------------------------------------------------------------
// Browse / purge wrappers (source-scoped)
// ---------------------------------------------------------------------------

export async function listConversations({ q, limit } = {}) {
  const [rows, blocklist] = await Promise.all([
    humanActivity.listConversations({ source: SOURCE, q, limit }),
    readBlocklist(),
  ]);
  const blocked = new Set(blocklist.handles);
  return rows.map((row) => {
    const handleKey = blocklistKey(row.handle);
    return {
      ...row,
      chatKey: encodeChatKey(row.chatGuid),
      blocked: !!(handleKey && blocked.has(handleKey)),
    };
  });
}

export async function listConversationEvents(chatKey, { limit, before } = {}) {
  const chatGuid = decodeChatKey(chatKey);
  if (chatGuid == null) return { chatGuid: null, chatKey, events: [] };
  const events = await humanActivity.listEvents({
    source: SOURCE,
    chatGuid,
    to: before || undefined,
    limit,
  });
  return {
    chatGuid,
    chatKey: encodeChatKey(chatGuid),
    events,
  };
}

export async function purgeConversation(chatKey) {
  const chatGuid = decodeChatKey(chatKey);
  if (chatGuid == null) return { deleted: 0, chatGuid: null };
  const result = await humanActivity.deleteEvents({ source: SOURCE, chatGuid });
  return { ...result, chatGuid, chatKey: encodeChatKey(chatGuid) };
}

export async function deleteEvent(id) {
  if (!id) return { deleted: 0 };
  // Scope to imessage so a typo'd id from another source can't be wiped via this route.
  return humanActivity.deleteEvents({ ids: [String(id)], source: SOURCE });
}

export async function getStats() {
  const [activity, blocklist, status] = await Promise.all([
    humanActivity.sourceStats(SOURCE),
    readBlocklist(),
    getStatus().catch(() => null),
  ]);
  return {
    ...activity,
    blockedCount: blocklist.handles.length,
    blocklistUpdatedAt: blocklist.updatedAt,
    sync: status,
  };
}

// Re-export normalize helpers for tests / callers that only import this module.
export { normalizeIdentifier, normalizePhone };
