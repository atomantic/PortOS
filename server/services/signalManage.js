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
  return withSignalPrivacyLock(() => writeBlocklist(blocklist));
}
export function blockConversation(conversationId, { purgeExisting = false } = {}) {
  return withSignalPrivacyLock(async () => {
    const current = await readBlocklist();
    const saved = await writeBlocklist({ ...current, conversationIds: [...current.conversationIds, conversationId] });
    return { ...saved, ...(purgeExisting ? await purge(conversationId) : {}) };
  });
}
