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
  };
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
