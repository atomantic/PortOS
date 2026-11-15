// Which sync actions a message account offers, and how a cached message's read state is classified.
//
// Message-account sync capability + read-state helpers (#9968): `accountSupportsSyncMode(account,
// mode)` (reads the server-derived `syncModes`; a missing field means every mode),
// `partitionAccountsBySyncMode(accounts, mode)` → `{ supported, excluded }` for aggregate sync
// actions, and `messageReadState(message)` → `'unread'`/`'read'`/`'unknown'` (unknown only when the
// provider recorded `null` read flags, e.g. Teams).
//
// Mirrors the server's transport table (`syncModes` on the account response); an account payload
// without the field (older server) is treated as supporting every mode, so nothing is hidden by a
// missing field.

import { ALL_SYNC_MODES as ALL_MODES } from '../../../server/lib/messageTransport.js';

export const accountSupportsSyncMode = (account, mode) =>
  (Array.isArray(account?.syncModes) ? account.syncModes : ALL_MODES).includes(mode);

/**
 * Split accounts for a requested mode into those that can run it and those
 * excluded because the provider cannot honor it.
 */
export function partitionAccountsBySyncMode(accounts, mode) {
  const supported = [];
  const excluded = [];
  for (const account of accounts) (accountSupportsSyncMode(account, mode) ? supported : excluded).push(account);
  return { supported, excluded };
}

/**
 * 'unknown' only when the provider explicitly recorded no measurement
 * (`null` on both flags). A record lacking the flags entirely keeps the legacy
 * unread-styling, and legacy `isRead: true` records stay read.
 */
export function messageReadState(message) {
  if (message?.isUnread === null && message?.isRead === null) return 'unknown';
  return message?.isUnread || !message?.isRead ? 'unread' : 'read';
}
