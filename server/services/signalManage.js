/** PortOS-side Signal management. Never mutates Signal's own database. */
import { ensureSchema, withTransaction } from '../lib/db.js';
import * as humanActivity from './humanActivity.js';
import { readBlocklist, writeBlocklist, handleKey, withSignalPrivacyLock } from './signalPrivacy.js';
export { readBlocklist } from './signalPrivacy.js';

export async function listConversations(options = {}) {
  const [rows, blocked] = await Promise.all([
    humanActivity.listConversations({ ...options, source: 'signal' }), readBlocklist(),
  ]);
  return rows.map((row) => ({
    ...row,
    conversationId: row.chatGuid,
    blocked: blocked.conversationIds.includes(row.chatGuid) || blocked.handles.includes(handleKey(row.handle)),
  }));
}
async function purge(conversationId) {
  const { deleteAutoTouchpoints } = await import('./tribe.js');
  await ensureSchema();
  return withTransaction(async (client) => {
    const events = await humanActivity.deleteEvents({ source: 'signal', conversationId, client });
    const touchpoints = await deleteAutoTouchpoints({ signalConversationId: conversationId, client });
    return { ...events, ...touchpoints, conversationId };
  });
}
export function purgeConversation(conversationId) {
  return withSignalPrivacyLock(() => purge(conversationId));
}
export function setBlocklist(blocklist) {
  return withSignalPrivacyLock(async () => {
    await readBlocklist();
    return writeBlocklist(blocklist);
  });
}
export function blockConversation(conversationId, { purgeExisting = false } = {}) {
  return withSignalPrivacyLock(async () => {
    const current = await readBlocklist();
    const saved = await writeBlocklist({ ...current, conversationIds: [...current.conversationIds, conversationId] });
    return { ...saved, ...(purgeExisting ? await purge(conversationId) : {}) };
  });
}

async function purgeHandles(keys) {
  const { deleteAutoTouchpoints } = await import('./tribe.js');
  await ensureSchema();
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT id, metadata->>'handle' AS handle, metadata->>'conversationId' AS conversation_id, participants
       FROM human_activity_events WHERE source = $1`,
      ['signal'],
    );
    // Signal stores the raw incoming handle and normalized participants. Outgoing
    // events have no raw handle, but sync still excludes them by participant.
    const matching = rows.filter(({ handle, participants }) => keys.has(handleKey(handle))
      || participants?.some(({ phone, email }) => keys.has(handleKey(phone || email))));
    if (matching.length === 0) return { purged: 0, touchpoints: 0 };

    const ids = matching.map(({ id }) => id);
    const { deleted: purged } = await humanActivity.deleteEvents({ source: 'signal', ids, client });
    const conversations = new Set(matching.map((row) => row.conversation_id).filter(Boolean));
    if (conversations.size === 0) return { purged, touchpoints: 0 };

    const remaining = await client.query(
      `SELECT DISTINCT metadata->>'conversationId' AS conversation_id
       FROM human_activity_events WHERE source = $1 AND metadata->>'conversationId' = ANY($2::text[])`,
      ['signal', [...conversations]],
    );
    for (const row of remaining.rows) conversations.delete(row.conversation_id);

    let touchpoints = 0;
    for (const conversationId of conversations) {
      touchpoints += (await deleteAutoTouchpoints({ signalConversationId: conversationId, client })).touchpoints;
    }
    return { purged, touchpoints };
  });
}

export function addBlockedHandles(handles, { purgeExisting = false } = {}) {
  const incoming = new Set((Array.isArray(handles) ? handles : [handles]).map(handleKey).filter(Boolean));
  return withSignalPrivacyLock(async () => {
    const current = await readBlocklist();
    const added = [...incoming].filter((key) => !current.handles.includes(key));
    const saved = await writeBlocklist({ ...current, handles: [...current.handles, ...added] });
    const purged = purgeExisting && incoming.size > 0
      ? await purgeHandles(incoming)
      : { purged: 0, touchpoints: 0 };
    return { ...saved, added, ...purged };
  });
}
