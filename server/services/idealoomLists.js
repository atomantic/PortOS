/**
 * Machine-local IdeaLoom list storage.
 *
 * This intentionally does not use brainStorage: native Brain entity types are
 * federated and memory-bridgeable, while IdeaLoom list records and vault sync
 * metadata must remain on the machine that owns the configured vault.
 */

import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, PATHS } from '../lib/fileUtils.js';
import { createCollectionStore } from '../lib/collectionStore.js';

export const IDEALOOM_LIST_SCHEMA_VERSION = 1;
const DEFAULT_SETTINGS = Object.freeze({ enabled: false, obsidianVaultId: null, autoSync: false });

const store = createCollectionStore({
  dir: join(PATHS.brain, 'idealoom-lists'),
  type: 'idealoom-lists',
  schemaVersion: IDEALOOM_LIST_SCHEMA_VERSION,
  defaultTypeIndexConfig: { settings: DEFAULT_SETTINGS },
  idPattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
});

export const ideaLoomListStore = () => store;

const timestamp = () => new Date().toISOString();
const withDefaults = (settings) => ({ ...DEFAULT_SETTINGS, ...(settings || {}) });

export async function getSettings() {
  const index = await store.loadTypeIndex();
  return withDefaults(index.config.settings);
}

export async function updateSettings(updates) {
  return store.queueTypeIndexWrite(async () => {
    const index = await store.loadTypeIndex();
    const settings = { ...withDefaults(index.config.settings), ...updates };
    await ensureDir(store.dir);
    await atomicWrite(store.typeIndexPath(), {
      ...index,
      config: { ...index.config, settings },
      updatedAt: timestamp(),
    });
    return settings;
  });
}

export async function listLists() {
  const ids = await store.listIds();
  const lists = await Promise.all(ids.map((id) => store.loadOne(id)));
  return lists.filter(Boolean).map((list) => ({ ...list })).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getList(id) {
  const list = await store.loadOne(id);
  return list ? { ...list } : null;
}

export async function createList(data) {
  const id = uuidv4();
  const now = timestamp();
  const list = { id, schemaVersion: IDEALOOM_LIST_SCHEMA_VERSION, ...data, createdAt: now, updatedAt: now };
  // Stamp the collection index even when a user only creates local lists and
  // never changes integration settings. This keeps the layout-version contract
  // visible to the boot-time collection verifier from the first write.
  await store.saveTypeIndex();
  await store.saveOne(id, list);
  return list;
}

/**
 * Store a list read from an IdeaLoom note without minting a new id or
 * replacing the note's timestamps. Import metadata is owned by the exchange
 * service, so normal list edits cannot accidentally overwrite it.
 */
export async function upsertImportedList(id, data) {
  if (!store.isValidId(id)) return null;
  await store.saveTypeIndex();
  return store.queueRecordWrite(id, async () => {
    const current = await store.loadOne(id);
    const now = timestamp();
    const list = {
      ...(current || {}),
      ...data,
      id,
      schemaVersion: IDEALOOM_LIST_SCHEMA_VERSION,
      sync: data.sync ?? current?.sync,
      createdAt: data.createdAt ?? current?.createdAt ?? now,
      updatedAt: data.updatedAt ?? current?.updatedAt ?? now,
    };
    await store.saveOneNow(id, list);
    return list;
  });
}

/** Update importer-owned local metadata without changing list content. */
export async function updateSyncMetadata(id, sync) {
  if (!store.isValidId(id)) return null;
  return store.queueRecordWrite(id, async () => {
    const current = await store.loadOne(id);
    if (!current) return null;
    const list = { ...current, sync: { ...(current.sync || {}), ...sync } };
    await store.saveOneNow(id, list);
    return list;
  });
}

export async function updateList(id, updates) {
  if (!store.isValidId(id)) return null;
  return store.queueRecordWrite(id, async () => {
    const current = await store.loadOne(id);
    if (!current) return null;
    const list = {
      ...current,
      ...updates,
      // Local sync metadata is importer-owned and cannot be overwritten by a
      // normal list edit. Later import/sync slices update it explicitly.
      sync: current.sync,
      id: current.id,
      schemaVersion: IDEALOOM_LIST_SCHEMA_VERSION,
      createdAt: current.createdAt,
      updatedAt: timestamp(),
    };
    await store.saveOneNow(id, list);
    return list;
  });
}

export async function deleteList(id) {
  if (!store.isValidId(id)) return false;
  // deleteOne is idempotent and resolves to undefined, so it cannot tell the
  // route whether anything was actually removed — returning it directly made
  // every DELETE answer 404. Probe for the record inside the same per-id write
  // queue as the removal so the existence check cannot race a concurrent write.
  return store.queueRecordWrite(id, async () => {
    if (!await store.loadOne(id)) return false;
    await store.deleteOneNow(id);
    return true;
  });
}
