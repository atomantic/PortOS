/**
 * iMessage activity manager (#2413) — PortOS-side browse / purge / blocklist
 * for events ingested from chat.db (#2151).
 *
 * Hard boundary: this module never opens Apple's Messages database. Deletes
 * remove rows from the machine-local `human_activity_events` table only.
 * Blocklisted handles are skipped on future syncs (see imessageSync.runSync).
 */
import { ensureSchema, withTransaction } from '../lib/db.js';
import { normalizeIdentifier, normalizePhone } from '../lib/tribeMatch.js';
import * as humanActivity from './humanActivity.js';
import { getStatus } from './imessageSync.js';
import { blocklistKey, readBlocklist, writeBlocklist, withImessagePrivacyLock } from './imessagePrivacy.js';

const SOURCE = 'imessage';

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
// Reads/writes live in imessagePrivacy.js; every mutation here and every sync
// pass runs under its shared lock.
// ---------------------------------------------------------------------------

export { blocklistKey, readBlocklist };

/** Replace the whole list. Refuses (UNREADABLE_STORE) to overwrite a store it cannot read. */
export function setBlocklist(handles) {
  return withImessagePrivacyLock(async () => {
    await readBlocklist();
    return writeBlocklist(handles);
  });
}

/**
 * Erase PortOS-side data for blocked handles, mirroring what the sync filter
 * would have skipped: received events whose stored counterpart handle normalizes
 * to a blocked key, plus from-me events in those chats whose participants are
 * all blocked. A chat left with no events also loses its `imsg:<chat>:<day>`
 * Tribe touchpoints (a chat that still holds other people's events keeps them).
 * One transaction so a failure leaves nothing half-erased.
 */
async function purgeHandles(keys, blockedKeys) {
  const { deleteAutoTouchpoints } = await import('./tribe.js');
  await ensureSchema();
  return withTransaction(async (client) => {
    // Stored handles are raw chat.db values and SQL can't run blocklistKey, so
    // resolve the matching raw values in JS from the distinct (handle, chat) pairs.
    const pairs = await client.query(
      `SELECT DISTINCT metadata->>'handle' AS handle, metadata->>'chatGuid' AS chat_guid
       FROM human_activity_events WHERE source = $1 AND metadata->>'handle' IS NOT NULL`,
      [SOURCE],
    );
    const wanted = new Set(keys);
    const matching = pairs.rows.filter((row) => wanted.has(blocklistKey(row.handle)));
    const chatGuids = new Set(matching.map((row) => row.chat_guid).filter(Boolean));
    let events = 0;
    for (const handle of new Set(matching.map((row) => row.handle))) {
      events += (await humanActivity.deleteEvents({ source: SOURCE, handle, client })).deleted;
    }
    if (chatGuids.size === 0) return { events, touchpoints: 0 };

    const sent = await client.query(
      `SELECT id, participants, metadata FROM human_activity_events
       WHERE source = $1 AND metadata->>'chatGuid' = ANY($2::text[])
         AND COALESCE(metadata->>'handle', '') = ''`,
      [SOURCE, [...chatGuids]],
    );
    const { kept } = filterBlockedActivityCandidates(sent.rows, blockedKeys);
    const keptIds = new Set(kept.map((row) => row.id));
    const sentIds = sent.rows.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
    if (sentIds.length > 0) events += (await humanActivity.deleteEvents({ source: SOURCE, ids: sentIds, client })).deleted;

    const remaining = await client.query(
      `SELECT DISTINCT metadata->>'chatGuid' AS chat_guid FROM human_activity_events
       WHERE source = $1 AND metadata->>'chatGuid' = ANY($2::text[])`,
      [SOURCE, [...chatGuids]],
    );
    const stillActive = new Set(remaining.rows.map((row) => row.chat_guid));
    let touchpoints = 0;
    for (const chatGuid of chatGuids) {
      if (stillActive.has(chatGuid)) continue;
      touchpoints += (await deleteAutoTouchpoints({ dedupePrefix: `imsg:${chatGuid}:`, client })).touchpoints;
    }
    return { events, touchpoints };
  });
}

/**
 * Add one or more handles to the blocklist. When `purgeExisting` is true, also
 * erases already-ingested events/touchpoints for every submitted handle — even
 * one that was already listed, which is how leaked rows get cleaned up.
 * Returns `{ handles, updatedAt, added, purged, touchpoints }`.
 */
export function addToBlocklist(handles, { purgeExisting = false } = {}) {
  const incoming = (Array.isArray(handles) ? handles : [handles])
    .map((h) => blocklistKey(h))
    .filter(Boolean);
  return withImessagePrivacyLock(async () => {
    const current = await readBlocklist();
    const existing = new Set(current.handles);
    const added = [...new Set(incoming)].filter((key) => !existing.has(key));
    const saved = await writeBlocklist([...current.handles, ...added]);
    const purge = purgeExisting && incoming.length > 0
      ? await purgeHandles(incoming, new Set(saved.handles))
      : { events: 0, touchpoints: 0 };
    return { ...saved, added, purged: purge.events, touchpoints: purge.touchpoints };
  });
}

export function removeFromBlocklist(handle) {
  const key = blocklistKey(handle);
  return withImessagePrivacyLock(async () => {
    const current = await readBlocklist();
    if (!key || !current.handles.includes(key)) return current;
    return writeBlocklist(current.handles.filter((h) => h !== key));
  });
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

/**
 * List iMessage conversations with identity enrichment (#2415): Tribe name
 * wins, then macOS Contacts cache, then raw handle. When `q` is set, filter
 * also matches resolved display names (not only stored titles).
 */
export async function listConversations({ q, limit } = {}) {
  // When searching by resolved name, pull a wider raw set then filter after
  // enrich — SQL only sees stored titles/handles.
  const needle = q != null && String(q).trim() ? String(q).trim().toLowerCase() : '';
  const rawLimit = needle ? Math.min(Math.max(Number(limit) || 500, 1) * 4, 2000) : limit;
  const [rows, blocklist] = await Promise.all([
    humanActivity.listConversations({
      source: SOURCE,
      // Skip SQL q when we will name-filter after resolve (SQL misses Contacts names).
      q: needle ? undefined : q,
      limit: rawLimit,
    }),
    readBlocklist(),
  ]);
  const blocked = new Set(blocklist.handles);
  let enrichConversationRow = (row) => row;
  try {
    const identity = await import('./identityResolve.js');
    const ctx = await identity.loadResolverContext();
    enrichConversationRow = (row) => identity.enrichConversationRow(row, ctx);
  } catch (err) {
    console.error(`⚠️ Identity resolve unavailable: ${err?.message || err}`);
  }

  const cap = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  const enriched = [];
  for (const row of rows) {
    const handleKey = blocklistKey(row.handle);
    const base = {
      ...row,
      chatKey: encodeChatKey(row.chatGuid),
      blocked: !!(handleKey && blocked.has(handleKey)),
    };
    const withName = enrichConversationRow(base);
    if (needle) {
      const hay = [
        withName.title,
        withName.displayName,
        withName.handle,
        withName.organization,
        withName.lastSummary,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    enriched.push(withName);
    if (enriched.length >= cap) break;
  }
  return enriched;
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
  let enrichedEvents = events;
  let conversationMeta = null;
  try {
    const identity = await import('./identityResolve.js');
    const ctx = await identity.loadResolverContext();
    enrichedEvents = events.map((ev) => identity.enrichActivityEvent(ev, ctx));
    // Conversation header identity from the first event handle or chat title.
    const sampleHandle = events.find((e) => e.metadata?.handle)?.metadata?.handle
      || events[0]?.title
      || '';
    if (sampleHandle) {
      conversationMeta = identity.enrichConversationRow({
        handle: events.find((e) => e.metadata?.handle)?.metadata?.handle || null,
        title: events[0]?.title || '',
      }, ctx);
    }
  } catch (err) {
    console.error(`⚠️ Identity resolve unavailable: ${err?.message || err}`);
  }
  return {
    chatGuid,
    chatKey: encodeChatKey(chatGuid),
    events: enrichedEvents,
    identity: conversationMeta
      ? {
        displayName: conversationMeta.displayName,
        personId: conversationMeta.personId,
        contactId: conversationMeta.contactId,
        organization: conversationMeta.organization,
        identitySource: conversationMeta.identitySource,
      }
      : null,
  };
}

export function purgeConversation(chatKey) {
  const chatGuid = decodeChatKey(chatKey);
  if (chatGuid == null) return Promise.resolve({ deleted: 0, chatGuid: null });
  return withImessagePrivacyLock(async () => {
    const { deleteAutoTouchpoints } = await import('./tribe.js');
    await ensureSchema();
    // Touchpoint dedupe keys are imsg:<chatGuid>:<day>; erase both stores together.
    return withTransaction(async (client) => {
      const result = await humanActivity.deleteEvents({ source: SOURCE, chatGuid, client });
      await deleteAutoTouchpoints({ dedupePrefix: `imsg:${chatGuid}:`, client });
      return { ...result, chatGuid, chatKey: encodeChatKey(chatGuid) };
    });
  });
}

export function deleteEvent(id) {
  if (!id) return Promise.resolve({ deleted: 0 });
  // Scope to imessage so a typo'd id from another source can't be wiped via this route.
  return withImessagePrivacyLock(() => humanActivity.deleteEvents({ ids: [String(id)], source: SOURCE }));
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
