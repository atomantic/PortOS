/**
 * Media tombstones — durable record of deliberate video/image deletes so a
 * peer that still holds the file cannot resurrect it on the next union sync.
 * Video tombstones key on the row `id`; image tombstones on the filename.
 * Persists to data/media-tombstones.json as `{ version, video: [], image: [] }`.
 */
import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import {
  DEFAULT_TOMBSTONE_LIMIT,
  normalizeTombstones,
  recordTombstone,
  mergeTombstones,
  isTombstoned,
  clearTombstone,
} from '../lib/tombstones.js';

const FILE = () => join(PATHS.data, 'media-tombstones.json');
const SCHEMA_VERSION = 1;
const KEY_FIELD = 'key';
const KINDS = ['video', 'image'];
const queueWrite = createFileWriteQueue();

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown media kind: ${kind}`);
}

// STRICT: an unreadable file rejects rather than being rewritten as empty.
async function readStore() {
  const raw = await readJSONFile(FILE(), null, { strict: true });
  const src = isPlainObject(raw) ? raw : {};
  return {
    version: SCHEMA_VERSION,
    video: normalizeTombstones(src.video, KEY_FIELD),
    image: normalizeTombstones(src.image, KEY_FIELD),
  };
}

const writeStore = (store) => atomicWrite(FILE(), store);

export function recordMediaTombstone(kind, key, deletedAt) {
  assertKind(kind);
  return queueWrite(async () => {
    const store = await readStore();
    store[kind] = recordTombstone(store[kind], key, { keyField: KEY_FIELD, deletedAt, limit: DEFAULT_TOMBSTONE_LIMIT });
    await writeStore(store);
    return store[kind].find((t) => t[KEY_FIELD] === key) ?? null;
  });
}

// Undo a tombstone recorded for a delete that then failed.
export function clearMediaTombstone(kind, key) {
  assertKind(kind);
  return queueWrite(async () => {
    const store = await readStore();
    store[kind] = clearTombstone(store[kind], key, KEY_FIELD);
    await writeStore(store);
  });
}

export async function listMediaTombstones(kind) {
  assertKind(kind);
  return (await readStore())[kind];
}

export function mergeMediaTombstones(kind, remote) {
  assertKind(kind);
  return queueWrite(async () => {
    const store = await readStore();
    const before = new Set(store[kind].map((t) => `${t[KEY_FIELD]}@${t.deletedAt}`));
    const { merged, changed } = mergeTombstones(store[kind], remote, { keyField: KEY_FIELD });
    if (changed) {
      store[kind] = merged;
      await writeStore(store);
    }
    return { added: merged.filter((t) => !before.has(`${t[KEY_FIELD]}@${t.deletedAt}`)) };
  });
}

export async function isMediaTombstoned(kind, key, liveStamp) {
  assertKind(kind);
  return isTombstoned((await readStore())[kind], key, liveStamp, KEY_FIELD);
}
