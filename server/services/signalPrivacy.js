import { z } from 'zod';
// Machine-local exclusions share a queue with sync so a completed privacy change
// cannot be followed by an older in-flight batch writing excluded records.
import { dataPath, atomicWrite, readJSONFileStrict, unreadableStoreError } from '../lib/fileUtils.js';
import { identityFromHandle } from '../lib/tribeMatch.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';

const blocklistSchema = z.object({
  handles: z.array(z.string()).default([]),
  conversationIds: z.array(z.string()).default([]),
  updatedAt: z.string().nullable().optional(),
});
const queue = createKeyCachedQueue();
export const withSignalPrivacyLock = (work) => queue('signal', work);
export function handleKey(value) {
  const raw = String(value ?? '').trim();
  const identity = identityFromHandle(raw);
  return identity.phone || identity.email || raw.toLowerCase();
}
const unique = (values, normalize) => [...new Set((values || []).map(normalize).filter(Boolean))].sort();
export async function readBlocklist() {
  const path = dataPath('signal-blocklist.json');
  const { ok, value } = await readJSONFileStrict(path, { handles: [], conversationIds: [] }, { allowArray: false });
  const parsed = blocklistSchema.safeParse(value);
  if (!ok || !parsed.success) throw unreadableStoreError(path);
  return {
    handles: unique(parsed.data.handles, handleKey),
    conversationIds: unique(parsed.data.conversationIds, (v) => String(v).trim()),
    updatedAt: parsed.data.updatedAt || null,
  };
}
export async function writeBlocklist({ handles, conversationIds }) {
  const payload = {
    handles: unique(handles, handleKey),
    conversationIds: unique(conversationIds, (v) => String(v).trim()),
    updatedAt: new Date().toISOString(),
  };
  await atomicWrite(dataPath('signal-blocklist.json'), JSON.stringify(payload, null, 2));
  return payload;
}
export function filterBlockedMessages(messages, blocklist) {
  const handles = new Set(blocklist.handles);
  const conversations = new Set(blocklist.conversationIds);
  return messages.filter((message) => !conversations.has(message.conversationId)
    && !(message.handles || []).some((handle) => handles.has(handleKey(handle))));
}
