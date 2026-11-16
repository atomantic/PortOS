/**
 * Snapshot checksum helpers for cross-instance sync.
 *
 * A category's checksum lets the orchestrator skip the full payload transfer when nothing moved (three getters had grown byte-identical copies: `dataSync.js`, `digital-twin-sync.js`, `peerUsage.js`). Two flavours: `snapshotChecksum(data)` hashes `JSON.stringify`, so it is key-INSERTION-ORDER sensitive and correct only where the getter already canonicalizes its ordering (sorted arrays, deterministically rebuilt objects); `canonicalSnapshotChecksum(data)` hashes `canonicalStringify` (recursively key-sorted), so converged machines hash alike regardless of write order: use it for any payload whose top level is a map keyed by wire-supplied ids (`peerUsage.js`). The wrong choice isn't a crash: it is two converged peers whose checksums never match, which the sync UI reads as "behind" forever.
 */

import crypto from 'crypto';
import { canonicalStringify } from './objects.js';

/** md5 of `JSON.stringify(data)` — insertion-order sensitive. */
export function snapshotChecksum(data) {
  return crypto.createHash('md5').update(JSON.stringify(data)).digest('hex');
}

/** md5 of `canonicalStringify(data)` — stable across machines and write order. */
export function canonicalSnapshotChecksum(data) {
  return crypto.createHash('md5').update(canonicalStringify(data)).digest('hex');
}
