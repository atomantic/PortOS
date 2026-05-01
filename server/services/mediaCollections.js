/**
 * Media Collections
 *
 * User-named buckets for image filenames + video ids. Many-to-many: the same
 * media item can live in any number of collections at once. Persisted to
 * data/media-collections.json as a single { collections: [...] } document.
 *
 * An item is identified by `{ kind: 'image'|'video', ref: <filename|videoId> }`.
 * A collection's `coverKey` is `null` (auto: newest item) or `"<kind>:<ref>"`
 * to pin a specific item as the cover thumbnail.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, atomicWrite, readJSONFile, ensureDir } from '../lib/fileUtils.js';

const STATE_PATH = join(PATHS.data, 'media-collections.json');

export const ERR_NOT_FOUND = 'NOT_FOUND';
export const ERR_DUPLICATE = 'DUPLICATE';
export const ERR_VALIDATION = 'VALIDATION_ERROR';
const makeErr = (message, code) => Object.assign(new Error(message), { code });

export const NAME_MAX_LENGTH = 80;
export const DESCRIPTION_MAX_LENGTH = 500;
export const REF_MAX_LENGTH = 256;
export const ITEMS_MAX = 5000;

const ITEM_KIND = new Set(['image', 'video']);

export const itemKey = (it) => `${it.kind}:${it.ref}`;

const DEFAULT_STATE = { collections: [] };

const sanitizeItem = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (!ITEM_KIND.has(raw.kind)) return null;
  if (typeof raw.ref !== 'string') return null;
  const ref = raw.ref.trim();
  if (!ref || ref.length > REF_MAX_LENGTH) return null;
  // The DELETE-item route key is `<kind>:<ref>` split on the first `:`. A
  // ref that contains `:` would be unambiguously persisted but ambiguously
  // addressable via the REST surface — reject it here so persisted data
  // always round-trips.
  if (ref.includes(':')) return null;
  // A hand-edited or corrupted `addedAt` would feed NaN into the cover
  // resolver's Date sort — replace anything unparseable with now().
  const parsed = typeof raw.addedAt === 'string' ? Date.parse(raw.addedAt) : NaN;
  const addedAt = Number.isFinite(parsed) ? raw.addedAt : new Date().toISOString();
  return { kind: raw.kind, ref, addedAt };
};

const sanitizeCollection = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.name !== 'string') return null;
  const name = raw.name.trim().slice(0, NAME_MAX_LENGTH);
  if (!name) return null;
  const description = typeof raw.description === 'string'
    ? raw.description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  const seen = new Set();
  const items = [];
  if (Array.isArray(raw.items)) {
    for (const it of raw.items) {
      const s = sanitizeItem(it);
      if (!s) continue;
      const key = itemKey(s);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(s);
      if (items.length >= ITEMS_MAX) break;
    }
  }
  // Cover key is only meaningful when it points at an item that's in the
  // collection; otherwise drop it back to auto so the UI doesn't render a
  // dangling thumbnail reference.
  const coverKey = typeof raw.coverKey === 'string' && seen.has(raw.coverKey)
    ? raw.coverKey
    : null;
  const createdAt = typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString();
  const updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : createdAt;
  return { id: raw.id, name, description, coverKey, items, createdAt, updatedAt };
};

export async function listCollections() {
  await ensureDir(PATHS.data);
  const raw = await readJSONFile(STATE_PATH, DEFAULT_STATE, { logError: false });
  if (!Array.isArray(raw.collections)) return [];
  const seen = new Set();
  const out = [];
  for (const c of raw.collections) {
    const s = sanitizeCollection(c);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

export async function getCollection(id) {
  const all = await listCollections();
  const c = all.find((x) => x.id === id);
  if (!c) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
  return c;
}

const writeAll = async (collections) => {
  await atomicWrite(STATE_PATH, { collections });
  return collections;
};

export async function createCollection({ name, description = '' }) {
  // Service-layer guards mirror sanitizeCollection so a direct caller
  // (tests, future internal usage) can't persist a record that the next
  // listCollections() read would silently drop.
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > NAME_MAX_LENGTH) {
    throw makeErr('Collection name is required (1..' + NAME_MAX_LENGTH + ' chars)', ERR_VALIDATION);
  }
  const trimmedDescription = typeof description === 'string'
    ? description.trim().slice(0, DESCRIPTION_MAX_LENGTH)
    : '';
  const all = await listCollections();
  const now = new Date().toISOString();
  const next = {
    id: randomUUID(),
    name: trimmedName,
    description: trimmedDescription,
    coverKey: null,
    items: [],
    createdAt: now,
    updatedAt: now,
  };
  await writeAll([...all, next]);
  return next;
}

export async function updateCollection(id, patch) {
  const all = await listCollections();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
  const cur = all[idx];
  // Cover key validation is deferred to sanitizeCollection on read, but we
  // also reject up-front so the API gives a clear error rather than silently
  // dropping the cover.
  if (patch.coverKey != null && !cur.items.find((it) => itemKey(it) === patch.coverKey)) {
    throw makeErr('coverKey must reference an item in this collection', ERR_VALIDATION);
  }
  const merged = {
    ...cur,
    ...('name' in patch ? { name: patch.name } : {}),
    ...('description' in patch ? { description: patch.description } : {}),
    ...('coverKey' in patch ? { coverKey: patch.coverKey } : {}),
    updatedAt: new Date().toISOString(),
  };
  const next = [...all];
  next[idx] = merged;
  await writeAll(next);
  return merged;
}

export async function deleteCollection(id) {
  const all = await listCollections();
  if (!all.find((c) => c.id === id)) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
  await writeAll(all.filter((c) => c.id !== id));
  return { id };
}

export async function addItem(id, item) {
  // Mirror sanitizeItem so direct callers can't write a record that the
  // next listCollections() would drop (silent add).
  if (!item || !ITEM_KIND.has(item.kind)) {
    throw makeErr('item.kind must be "image" or "video"', ERR_VALIDATION);
  }
  const ref = typeof item.ref === 'string' ? item.ref.trim() : '';
  if (!ref || ref.length > REF_MAX_LENGTH || ref.includes(':')) {
    throw makeErr('item.ref invalid (empty, too long, or contains ":")', ERR_VALIDATION);
  }
  const all = await listCollections();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
  const cur = all[idx];
  const key = `${item.kind}:${ref}`;
  if (cur.items.find((it) => itemKey(it) === key)) {
    throw makeErr(`Item already in collection: ${key}`, ERR_DUPLICATE);
  }
  if (cur.items.length >= ITEMS_MAX) {
    throw makeErr(`Collection full (limit ${ITEMS_MAX})`, ERR_VALIDATION);
  }
  const merged = {
    ...cur,
    items: [...cur.items, { kind: item.kind, ref, addedAt: new Date().toISOString() }],
    updatedAt: new Date().toISOString(),
  };
  const next = [...all];
  next[idx] = merged;
  await writeAll(next);
  return merged;
}

export async function removeItem(id, key) {
  const all = await listCollections();
  const idx = all.findIndex((c) => c.id === id);
  if (idx < 0) throw makeErr(`Collection not found: ${id}`, ERR_NOT_FOUND);
  const cur = all[idx];
  const before = cur.items.length;
  const items = cur.items.filter((it) => itemKey(it) !== key);
  if (items.length === before) throw makeErr(`Item not in collection: ${key}`, ERR_NOT_FOUND);
  const merged = {
    ...cur,
    items,
    // Drop the cover if it pointed at the removed item — sanitizeCollection
    // would do this on the next read, but doing it here keeps the in-memory
    // return consistent with what's persisted.
    coverKey: cur.coverKey === key ? null : cur.coverKey,
    updatedAt: new Date().toISOString(),
  };
  const next = [...all];
  next[idx] = merged;
  await writeAll(next);
  return merged;
}
