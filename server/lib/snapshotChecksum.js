/**
 * Snapshot checksum helpers for cross-instance sync.
 *
 * A sync category's checksum is what lets the orchestrator skip the full
 * payload transfer when nothing moved, so every snapshot getter needs one.
 * These are the shared implementations — three getters had grown their own
 * byte-identical copy (`dataSync.js`, `digital-twin-sync.js`, `peerUsage.js`).
 *
 * Two variants, and the choice matters:
 *
 * - `snapshotChecksum` hashes `JSON.stringify` output, so it is sensitive to
 *   key INSERTION ORDER. Correct only where the getter already canonicalizes
 *   ordering itself (sorted arrays, deterministically rebuilt objects).
 * - `canonicalSnapshotChecksum` hashes `canonicalStringify`, which sorts object
 *   keys recursively — so two machines holding identical data hash the same
 *   regardless of the order they happened to write it in. Use this for any
 *   payload whose top level is a map keyed by something arriving over the wire.
 *
 * Getting that wrong is not a crash: it is two converged peers whose checksums
 * never match, which the sync UI reads as "behind" forever.
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
