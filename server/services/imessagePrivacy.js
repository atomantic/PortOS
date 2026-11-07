import { z } from 'zod';
// Machine-local exclusions share a queue with sync so a completed privacy change
// cannot be followed by an older in-flight batch writing excluded records.
// The reader refuses unreadable/malformed bytes (instead of serving an empty
// list) so sync fails closed and a write never clobbers a store it could not read.
import { dataPath, atomicWrite, readJSONFileStrict, unreadableStoreError } from '../lib/fileUtils.js';
import { identityFromHandle } from '../lib/tribeMatch.js';
import { createKeyCachedQueue } from '../lib/createKeyCachedQueue.js';

const BLOCKLIST_FILE = 'imessage-blocklist.json';

const blocklistSchema = z.object({
  handles: z.array(z.string()).default([]),
  updatedAt: z.string().nullable().optional(),
});

const queue = createKeyCachedQueue();
// Not re-entrant: work running inside the lock must not call it again.
export const withImessagePrivacyLock = (work) => queue('imessage', work);

/**
 * Stable match key for a raw handle (phone → E.164-ish, email → lowercased).
 * Empty string when the handle can't be classified.
 */
export function blocklistKey(handle) {
  const id = identityFromHandle(handle);
  if (id.phone) return id.phone;
  if (id.email) return id.email;
  // Fallback: trim + lower so free-form keys still dedupe case-insensitively.
  return handle == null ? '' : String(handle).trim().toLowerCase();
}

const uniqueKeys = (handles) => [...new Set((handles || []).map(blocklistKey).filter(Boolean))].sort();

/** Throws UNREADABLE_STORE when the file is unreadable, corrupt, or has a non-array `handles`. */
export async function readBlocklist() {
  const path = dataPath(BLOCKLIST_FILE);
  const { ok, value } = await readJSONFileStrict(path, { handles: [] }, { allowArray: false });
  const parsed = blocklistSchema.safeParse(value);
  if (!ok || !parsed.success) throw unreadableStoreError(path);
  return { handles: uniqueKeys(parsed.data.handles), updatedAt: parsed.data.updatedAt || null };
}

export async function writeBlocklist(handles) {
  const payload = { handles: uniqueKeys(handles), updatedAt: new Date().toISOString() };
  await atomicWrite(dataPath(BLOCKLIST_FILE), JSON.stringify(payload, null, 2));
  return payload;
}
