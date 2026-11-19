import { EventEmitter } from 'node:events';

/**
 * Zero-dependency leaf event bus for Code Animation notifications (#16905).
 *
 * Extracted so modules in `server/services/codeAnimation/` don't statically
 * import `server/services/socket.js`.
 *
 * Events:
 *   - 'changed' -> { id, kind? }
 */
export const codeAnimationEvents = new EventEmitter();

/**
 * Broadcast an invalidation frame when a code animation project/job updates.
 *
 * @param {string} id - Project or job ID.
 * @param {string} [kind] - Optional change discriminator (e.g. 'deleted', 'poster').
 */
export function emitCodeAnimationChanged(id, kind) {
  codeAnimationEvents.emit('changed', kind ? { id, kind } : { id });
}
