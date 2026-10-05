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
import { localizeImageUrl } from './localize.js';
import { withBackupAssetPublication } from '../../lib/backupSnapshotBoundary.js';

// Read paths + federation entry points pass straight through to the store. The
// asset-manifest filename resolver lives in logic.js (pure) and is re-exported
// here so peerSync imports a single module (mirrors creativeDirector/local.js
// re-exporting startingImageFilename).
export {
  listBoards,
  getBoard,
  listBoardIds,
  listBoardNames,
  mergeBoardsFromSync,
  pruneTombstonedBoards,
} from './db.js';
export { imageUrlToAppAsset } from './logic.js';

// Pinterest importer (link + manual "Sync now"). Lives in its own module
// (network I/O + image download) but is surfaced here so routes import a single
// moodBoard entry. It fires its own federation emits after each store mutation.
export { linkPinterestBoard, unlinkPinterestBoard, syncPinterestBoard } from './pinterest.js';
export { importPrivatePinterestBoard } from './privatePinterest.js';

// X.com (Twitter) post importer — one-shot "paste a post URL, pull its
// photos/video in". Lives in its own module (network I/O + downloads) but
// surfaced here so routes import a single moodBoard entry; fires its own
// federation emit after the store mutation.
export { importXPost } from './xPost.js';

// Re-host external image URLs into the local gallery (boards never serve remote URLs).
export { localizeBoardMedia } from './localize.js';

// Collage compilation + video frame extraction (fires its own federation emits).
export { composeBoardCollage, extractItemFrames } from './collage.js';

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
// Pinned/added remote image URLs are downloaded first so the item is born local
// (falls back to the URL when the host is unreachable — localizeBoardMedia can
// retry later).
import { localImageFilename, assetBasename } from '../../lib/localImageFilename.js';

// Gallery prompt (image sidecar / video history) for a pinned gallery item, or
// '' when none is recorded. `videoHistory` lets a batch caller load it once.
async function lookupGalleryPrompt(input, videoHistory) {
  if (!input || (input.type !== 'image' && input.type !== 'video')) return '';
  try {
    if (input.type === 'image') {
      let filename = null;
      if (typeof input.mediaKey === 'string' && input.mediaKey.startsWith('image:')) {
        filename = assetBasename(input.mediaKey.slice('image:'.length));
      }
      if (!filename && input.imageUrl) {
        filename = localImageFilename(input.imageUrl);
      }
      if (!filename) return '';
      const { readImageSidecar } = await import('../imageGen/local.js');
      const { metadata } = await readImageSidecar(filename).catch(() => ({}));
      const prompt = typeof metadata?.prompt === 'string' ? metadata.prompt.trim() : '';
      return prompt && prompt !== '(no prompt)' ? prompt : '';
    }
    if (typeof input.mediaKey !== 'string' || !input.mediaKey.startsWith('video:')) return '';
    const ref = input.mediaKey.slice('video:'.length);
    const history = videoHistory ?? await (await import('../videoGen/history.js')).loadHistory().catch(() => []);
    const entry = (history || []).find((row) => row && (row.id === ref || row.filename === ref || row.thumbnail === ref));
    const prompt = typeof entry?.prompt === 'string' ? entry.prompt.trim() : '';
    return prompt && prompt !== '(no prompt)' ? prompt : '';
  } catch (_err) {
    return '';
  }
}

// Auto-populate item.caption from gallery sidecar / video history prompt when
// no caption was explicitly supplied.
async function resolveGalleryItemCaption(input) {
  if (!input || (input.type !== 'image' && input.type !== 'video')) return input;
  if (typeof input.caption === 'string' && input.caption.trim()) return input;
  const prompt = await lookupGalleryPrompt(input);
  return prompt ? { ...input, caption: prompt } : input;
}

// Board "Analyze" must not spend vision runs on pins whose generation prompt is
// already on record. Pins made before captions were auto-filled from the gallery
// have neither analysis, prompt nor caption; copy the gallery prompt onto those
// as their caption (never overwriting user text) so the client plan skips them.
export async function backfillGalleryPrompts(id) {
  const board = await store.getBoard(id);
  if (!board) return null;
  const needs = (board.items || []).filter((it) => (it.type === 'image' || it.type === 'video')
    && !it.analysis?.prompt?.trim() && !it.prompt?.trim() && !it.caption?.trim());
  if (!needs.length) return board;
  const hasVideo = needs.some((it) => it.type === 'video');
  const history = hasVideo ? await (await import('../videoGen/history.js')).loadHistory().catch(() => []) : [];
  let changed = false;
  for (const it of needs) {
    const prompt = await lookupGalleryPrompt(it, history);
    if (!prompt) continue;
    await store.updateBoardItem(id, it.id, { caption: prompt.slice(0, 2000) });
    changed = true;
  }
  if (!changed) return board;
  emitRecordUpdated('moodBoard', id);
  return store.getBoard(id);
}

async function withLocalImage(input) {
  if (!input || (input.type !== 'image' && input.type !== 'video')) return input;
  return input.imageUrl ? { ...input, imageUrl: await localizeImageUrl(input.imageUrl) } : input;
}

// A row that first names an image re-hosted just now commits under the backup
// lease (#9982); every other item write stays outside it.
const commitItem = (rehosted, commit) => (rehosted ? withBackupAssetPublication(commit) : commit());

export async function addBoardItem(id, itemInput) {
  const resolved = await resolveGalleryItemCaption(itemInput);
  const localized = await withLocalImage(resolved);
  const item = await commitItem(localized?.imageUrl !== resolved?.imageUrl, () => store.addBoardItem(id, localized));
  emitRecordUpdated('moodBoard', id);
  return item;
}

export async function updateBoardItem(id, itemId, patch) {
  const localized = patch?.imageUrl ? { ...patch, imageUrl: await localizeImageUrl(patch.imageUrl) } : patch;
  const item = await commitItem(localized?.imageUrl !== patch?.imageUrl, () => store.updateBoardItem(id, itemId, localized));
  emitRecordUpdated('moodBoard', id);
  return item;
}

export async function removeBoardItem(id, itemId) {
  const board = await store.removeBoardItem(id, itemId);
  emitRecordUpdated('moodBoard', id);
  return board;
}
