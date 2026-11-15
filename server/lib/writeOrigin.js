/**
 * `writeOriginScope` middleware and `currentWriteOrigin()` carry the client socket label of a write so
 * record-changed broadcasts can name the originating tab.
 *
 * `writeOriginScope` middleware + `currentWriteOrigin()`: the client socket label (`X-PortOS-Origin`)
 * a write carries through its async work, so a record-changed broadcast can name it and the asking tab
 * can skip refetching its own change. A label, never an authority.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

// The client socket that asked for a write (`X-PortOS-Origin`), carried through the request's
// async work so a record-changed broadcast can name it and that tab can skip refetching a change
// its own reply already applied. A label only, never an authority: every tab still receives the
// event, and a spoofed value can only make a tab skip its own refresh.
const ORIGIN_HEADER = 'x-portos-origin';
const ORIGIN_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const originStore = new AsyncLocalStorage();

/** Express middleware: runs the rest of the request with its origin label, when it sent a valid one. */
export function writeOriginScope(req, _res, next) {
  const origin = req.get?.(ORIGIN_HEADER);
  if (typeof origin === 'string' && ORIGIN_PATTERN.test(origin)) originStore.run(origin, next);
  else next();
}

/** The origin label of the request this code runs for, or null. */
export const currentWriteOrigin = () => originStore.getStore() ?? null;
