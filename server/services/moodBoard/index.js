/**
 * Mood Board service — public entry (issue #911).
 *
 * Mood boards are db-primary records (no file backend). As of #1564 they FEDERATE
 * across peers via the per-record peer-sync push pipeline (record kind
 * `moodBoard`, sync category `moodBoards`). The pure transforms live in logic.js
 * (unit-tested without a DB); db.js does the row I/O + per-board row locking +
 * the LWW/tombstone merge. Routes import from here.
 *
 * This module wraps db.js's mutators with the peer-sync announce hooks — mirroring
 * authors/index.js — so creating/editing/deleting a board propagates to subscribed
 * peers. Announce is routed through the recordEvents subscription adapter (a no-op
 * until peerSync registers it at boot) so this store doesn't import peerSync —
 * peerSync statically imports mergeBoardsFromSync from here, so importing it back
 * would close a load-order cycle.
 */

import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';
import * as store from './db.js';

// Read paths + federation entry points pass straight through to the store. The
// asset-manifest filename resolver lives in logic.js (pure) and is re-exported
// here so peerSync imports a single module (mirrors creativeDirector/local.js
// re-exporting startingImageFilename).
export {
  listBoards,
  getBoard,
  listBoardIds,
  mergeBoardsFromSync,
  pruneTombstonedBoards,
} from './db.js';
export { imageUrlToAppAsset } from './logic.js';

// Announce a newly-created board to the per-record peer-sync pipeline: emit the
// 'updated' event so any existing subscription pushes it, AND auto-subscribe
// every moodBoards-enabled peer so brand-new boards (and their later tombstones)
// propagate. Call ONLY when a brand-new record was persisted. Mirrors
// authors/index.js announceNewAuthor.
function announceNewBoard(id) {
  emitRecordUpdated('moodBoard', id);
  autoSubscribeRecordToAllPeers('moodBoard', id).catch(() => {});
}

export async function createBoard(input) {
  const board = await store.createBoard(input);
  announceNewBoard(board.id);
  return board;
}

export async function updateBoard(id, patch) {
  const next = await store.updateBoard(id, patch);
  // A standalone board reaches peers only via its per-record subscription —
  // without this emit an edit never propagates after the initial subscribe.
  emitRecordUpdated('moodBoard', next.id);
  return next;
}

// Conflict-journal restore path (see db.restoreBoard). Re-propagate the restored
// version so it wins LWW on peers too.
export async function restoreBoard(id, patch) {
  const next = await store.restoreBoard(id, patch);
  emitRecordUpdated('moodBoard', next.id);
  return next;
}

export async function deleteBoard(id) {
  const result = await store.deleteBoard(id);
  // Soft-delete tombstone — push the deletion to subscribed peers immediately
  // (peerSync's delete listener reads the record with includeDeleted and pushes
  // the tombstone).
  emitRecordDeleted('moodBoard', id);
  return result;
}

// Inline item ops mutate the board record, so each propagates the whole board as
// a structural edit (human-pace affordances, not a hot loop — safe to emit every
// time; lastPushedHash + same-`updatedAt` LWW no-op dedup prevent ping-pong).
export async function addBoardItem(id, itemInput) {
  const item = await store.addBoardItem(id, itemInput);
  emitRecordUpdated('moodBoard', id);
  return item;
}

export async function updateBoardItem(id, itemId, patch) {
  const item = await store.updateBoardItem(id, itemId, patch);
  emitRecordUpdated('moodBoard', id);
  return item;
}

export async function removeBoardItem(id, itemId) {
  const board = await store.removeBoardItem(id, itemId);
  emitRecordUpdated('moodBoard', id);
  return board;
}
