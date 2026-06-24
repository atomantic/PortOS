/**
 * Mood Board — pure record transforms (issue #911).
 *
 * Storage-agnostic mutation semantics, mirroring the creativeDirector
 * projectsLogic split: each function takes a plain board record and returns the
 * next record (or throws a ServerError on a validation failure), leaving the
 * load/persist to the db module. A board holds a small bounded `items[]` inline
 * — image refs (media-key or external URL) or text notes — that feed the Create
 * suite. No file backend exists (mood boards are db-primary, local-only), so
 * this module has a single consumer (db.js); it stays a separate pure module so
 * the transforms are unit-testable without a live database.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { sanitizeSoftDeleteFields } from '../../lib/syncWire.js';

const isStr = (v) => typeof v === 'string';

// Bound the inline items[] so a single board row's JSONB can't grow without
// limit (a board is loaded/serialized whole on every read/write). Far above any
// realistic hand-curated board. Enforced in addItem (the add route surfaces the
// BOARD_FULL error); the item schema validates a single item, not the count.
export const MAX_ITEMS_PER_BOARD = 500;

function nowIso() {
  return new Date().toISOString();
}

// Build a fresh board record from a validated create input. `id`/`now` are
// injected by the caller (db.js) so this stays pure and testable.
export function buildBoardRecord(input, { id, now = nowIso() } = {}) {
  return {
    id,
    name: input.name,
    description: input.description ?? '',
    items: [],
    createdAt: now,
    updatedAt: now,
    // Soft-delete / LWW tombstone trio (#1564) — boards federate across peers
    // via the per-record push pipeline (record kind `moodBoard`, sync category
    // `moodBoards`), so a delete is a tombstone the merge keeps an out-of-date
    // peer from resurrecting. Mirrors the creativeDirector project record.
    deleted: false,
    deletedAt: null,
  };
}

/**
 * Normalize a raw board record into the canonical stored shape for a sync
 * round-trip. Returns null for a non-object or a record without a usable id
 * (mirrors `sanitizeProjectForSync`'s "drop on the floor" contract so a
 * malformed peer payload can't land). The board body (name/description/items)
 * passes through verbatim — it is all app-authored data — while the LWW key
 * (`updatedAt`) and the soft-delete trio are normalized so the wire/hash shape
 * is stable regardless of on-disk key position.
 */
export function sanitizeBoardForSync(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isStr(raw.id) || !raw.id) return null;
  const createdAt = isStr(raw.createdAt) ? raw.createdAt : new Date().toISOString();
  const updatedAt = isStr(raw.updatedAt) ? raw.updatedAt : createdAt;
  const { deleted, deletedAt } = sanitizeSoftDeleteFields(raw);
  return { ...raw, createdAt, updatedAt, deleted, deletedAt };
}

/**
 * LWW merge decision for one incoming board record against the local copy —
 * mirrors `mergeProjectRecord` (creativeDirector/projectsLogic.js):
 *   - remote sanitized here (drop-on-floor on a malformed payload → `next: null`).
 *   - No local counterpart → insert the remote verbatim (`inserted: true`).
 *   - Both present → newer `updatedAt` wins (`compareNewerWins`: epoch-ms,
 *     unparseable-loses, tie → local). Tombstones ride the same path.
 * Returns `{ next, inserted, remoteWins, changed }`; `changed` is false when the
 * winner is byte-identical to local. The whole record is LWW-overwritten (no
 * field-union), so it is hashed in full by `contentHashForRecord`.
 */
export function mergeBoardRecord(local, remoteRaw) {
  const remote = sanitizeBoardForSync(remoteRaw);
  if (!remote) return { next: null, inserted: false, remoteWins: false, changed: false };
  if (!local) return { next: remote, inserted: true, remoteWins: true, changed: true };
  const remoteWins = compareNewerWins(remote.updatedAt, local.updatedAt);
  const next = remoteWins ? remote : local;
  const changed = JSON.stringify(next) !== JSON.stringify(local);
  return { next, inserted: false, remoteWins, changed };
}

// Served-asset dir prefix → peer-sync asset-manifest `kind`. A board item's
// `imageUrl` can point at any same-origin app-path image the media UI surfaces:
// gallery renders (`/data/images/`) AND character/canon reference sheets
// (`/data/image-refs/`) — synthetic sources like `canon-sheet:`/`noun:` aren't
// valid media-keys, so PinToMoodBoardMenu pins them as an `imageUrl` only (their
// `previewUrl` is the `/data/image-refs/...` served path). Both dirs are
// federated asset kinds (see directoryForAssetKind in peerSync.js), so both must
// be advertised in the manifest or the receiver stores a board item pointing at
// a missing local file. Mirrors the prefix vocabulary of directoryForAssetKind.
const APP_IMAGE_URL_PREFIXES = Object.freeze([
  ['/data/images/', 'image'],
  ['/data/image-refs/', 'image-ref'],
]);

/**
 * Resolve a board item's app-path `imageUrl` to `{ kind, filename }` so the
 * peer-sync asset pipeline can hash + transfer the bytes via the right dir.
 * Returns null for an empty/non-string value, an external URL (`http(s)://…`,
 * `data:`, `blob:`), or any absolute path outside the served-asset dirs above —
 * the receiver resolves those itself. A bare/relative ref (no leading `/`) is
 * treated as a gallery image filename (legacy shape). A media-key reference
 * (`image:<ref>`) is handled separately by the manifest builder (it carries the
 * bare ref directly); this covers only the `imageUrl` pointer.
 */
export function imageUrlToAppAsset(imageUrl) {
  if (!isStr(imageUrl)) return null;
  const url = imageUrl.trim();
  if (!url) return null;
  if (/^(https?:|data:|blob:)/i.test(url)) return null;
  const baseOf = (s) => {
    const cut = s.split(/[?#]/)[0].split('/').pop();
    return cut || null;
  };
  if (!url.startsWith('/')) {
    const filename = baseOf(url); // bare/relative → gallery image (legacy shape)
    return filename ? { kind: 'image', filename } : null;
  }
  for (const [prefix, kind] of APP_IMAGE_URL_PREFIXES) {
    if (url.startsWith(prefix)) {
      const filename = baseOf(url.slice(prefix.length));
      return filename ? { kind, filename } : null;
    }
  }
  return null; // some other absolute path → not a served gallery asset
}

// Apply a PATCH to board-level fields (name/description). Absent keys preserve
// the original; a present empty string clears (description). `items` is managed
// only through the dedicated item ops below, never a bulk board PATCH.
export function applyBoardPatch(board, patch) {
  const next = { ...board };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  next.updatedAt = nowIso();
  return next;
}

// Normalize a validated item input into the stored item shape. An image item
// carries a `mediaKey` (an indexed `<kind>:<ref>` asset) OR an `imageUrl`
// (external/pinned), never required to have both; a text item carries `text`.
// `caption`/`source` are optional on both. The route schema guarantees the
// type-appropriate field is present, so this only fills the shared shape.
function normalizeItem(input, { id, now = nowIso() } = {}) {
  return {
    id,
    type: input.type,
    mediaKey: input.type === 'image' ? (input.mediaKey ?? null) : null,
    imageUrl: input.type === 'image' ? (input.imageUrl ?? null) : null,
    text: input.type === 'text' ? input.text : null,
    caption: input.caption ?? null,
    source: input.source ?? null,
    createdAt: now,
  };
}

export function addItem(board, itemInput) {
  const items = Array.isArray(board.items) ? board.items : [];
  if (items.length >= MAX_ITEMS_PER_BOARD) {
    throw new ServerError(`Board is full (max ${MAX_ITEMS_PER_BOARD} items)`, {
      status: 400,
      code: 'BOARD_FULL',
    });
  }
  const item = normalizeItem(itemInput, { id: `mbi-${randomUUID()}` });
  const next = { ...board, items: [...items, item], updatedAt: nowIso() };
  return { board: next, item };
}

// PATCH a single item's editable fields. caption/source apply to any item;
// the body fields are gated to the item's FIXED type (an item's kind can't
// change after creation) so a patch can't make a text item carry an imageUrl
// or an image item carry text — the schema permits every key, the invariant is
// enforced here where the item's type is known. Absent keys preserve; throws
// NOT_FOUND when the item id isn't on the board.
export function updateItem(board, itemId, patch) {
  const items = Array.isArray(board.items) ? board.items : [];
  const idx = items.findIndex((it) => it && it.id === itemId);
  if (idx === -1) {
    throw new ServerError('Item not found', { status: 404, code: 'NOT_FOUND' });
  }
  const current = items[idx];
  const updated = { ...current };
  const editableKeys = current.type === 'image'
    ? ['caption', 'source', 'imageUrl', 'mediaKey']
    : ['caption', 'source', 'text'];
  for (const key of editableKeys) {
    if (patch[key] !== undefined) updated[key] = patch[key];
  }
  // Reject a patch that would strip the item's required content (the schema
  // permits nulls so a partial edit can clear one of two image sources, but the
  // MERGED result must stay valid): an image keeps at least one of
  // mediaKey/imageUrl; a text item keeps non-empty text.
  if (updated.type === 'image' && !updated.mediaKey && !updated.imageUrl) {
    throw new ServerError('An image item must keep a mediaKey or imageUrl', { status: 400, code: 'INVALID_ITEM' });
  }
  if (updated.type === 'text' && (typeof updated.text !== 'string' || !updated.text.trim())) {
    throw new ServerError('A text item must keep non-empty text', { status: 400, code: 'INVALID_ITEM' });
  }
  const nextItems = [...items];
  nextItems[idx] = updated;
  const next = { ...board, items: nextItems, updatedAt: nowIso() };
  return { board: next, item: updated };
}

// Remove an item by id. Returns `removed: false` (no write) when the id is
// absent so the db layer can skip a wasted row rewrite.
export function removeItem(board, itemId) {
  const items = Array.isArray(board.items) ? board.items : [];
  const nextItems = items.filter((it) => !(it && it.id === itemId));
  if (nextItems.length === items.length) {
    return { board, removed: false };
  }
  const next = { ...board, items: nextItems, updatedAt: nowIso() };
  return { board: next, removed: true };
}

// Faithful conflict-restore of the restorable board fields (RESTORABLE_FIELDS.
// moodBoard = name/description/items). Unlike applyBoardPatch — the route PATCH
// path, which only touches name/description because items are managed through
// the dedicated item ops — a "restore my whole version" must bring back the
// board's items[]. The conflict resolver narrows `patch` to the allowed fields
// (via `pick`), so this just spreads the present ones and bumps updatedAt so the
// restore wins LWW and re-propagates. Mirrors creativeDirector's
// applyProjectPatch wholesale-spread restore path.
export function applyBoardRestore(board, patch) {
  const next = { ...board };
  if (patch.name !== undefined) next.name = patch.name;
  if (patch.description !== undefined) next.description = patch.description;
  if (Array.isArray(patch.items)) next.items = patch.items;
  next.updatedAt = nowIso();
  return next;
}
