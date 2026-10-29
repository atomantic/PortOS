/**
 * Media tombstones — durable record of deliberate video/image deletes so a
 * peer that still holds the file cannot resurrect it on the next union sync.
 * Video tombstones key on the row `id`; image tombstones on the filename.
 * Persists to data/media-tombstones.json as `{ version, video: [], image: [] }`,
 * plus a machine-local `inFlight` section while a local delete is underway.
 *
 * In-flight: a local delete records its tombstone before trashing the files
 * (crash safety) but the trash can still fail and withdraw it. Until the trash
 * commits, the tombstone filters rows HERE but is never exported (snapshot,
 * library manifest, delete response): a peer that merged a delete that never
 * happened would hide the owner's still-present row forever (#14088). A marker
 * left by a crash is settled at boot from file presence (mediaRestoreTombstones.js).
 */
import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite } from '../lib/fileUtils.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { isPlainObject } from '../lib/objects.js';
import {
  normalizeTombstones,
  recordTombstone,
  mergeTombstones,
  clearTombstone,
} from '../lib/tombstones.js';

const FILE = () => join(PATHS.data, 'media-tombstones.json');
const SCHEMA_VERSION = 1;
const KEY_FIELD = 'key';
const KINDS = ['video', 'image'];
// A tombstone that falls off the cap lets a peer that still holds the row or
// file bring it back, so both kinds keep 5000: far more deletes than a peer is
// likely to miss while offline. The image cap matches the library manifest
// schema (peerSyncValidation.js); video tombstones ride the uncapped
// videoHistory snapshot (dataSync.js).
const KIND_LIMITS = { video: 5000, image: 5000 };
const queueWrite = createFileWriteQueue();

function assertKind(kind) {
  if (!KINDS.includes(kind)) throw new Error(`Unknown media kind: ${kind}`);
}

// STRICT: an unreadable file rejects rather than being rewritten as empty.
async function readStore() {
  const raw = await readJSONFile(FILE(), null, { strict: true });
  const src = isPlainObject(raw) ? raw : {};
  const inFlight = isPlainObject(src.inFlight) ? src.inFlight : {};
  return {
    version: SCHEMA_VERSION,
    video: normalizeTombstones(src.video, KEY_FIELD),
    image: normalizeTombstones(src.image, KEY_FIELD),
    inFlight: {
      video: normalizeTombstones(inFlight.video, KEY_FIELD),
      image: normalizeTombstones(inFlight.image, KEY_FIELD),
    },
  };
}

const stampOf = (t) => `${t[KEY_FIELD]}@${t.deletedAt}`;

// A marker only means something while its exact tombstone is stored: one a
// newer (peer) delete replaced, or a clear removed, is dropped.
function inFlightStamps(store, kind) {
  const live = new Set(store[kind].map(stampOf));
  return store.inFlight[kind].filter((t) => live.has(stampOf(t)));
}

function writeStore(store) {
  const inFlight = {};
  for (const kind of KINDS) {
    const marks = inFlightStamps(store, kind);
    if (marks.length > 0) inFlight[kind] = marks;
  }
  const out = { version: store.version, video: store.video, image: store.image };
  return atomicWrite(FILE(), Object.keys(inFlight).length > 0 ? { ...out, inFlight } : out);
}

function assertKey(kind, key) {
  if (typeof key !== 'string' || key === '') {
    throw new Error(`A ${kind} tombstone needs a non-empty string key`);
  }
}

// A delete that cannot be recorded must fail rather than look recorded: the
// caller would trash the file with nothing stopping a peer from restoring it.
export function recordMediaTombstone(kind, key, deletedAt) {
  assertKind(kind);
  assertKey(kind, key);
  return queueWrite(async () => {
    const store = await readStore();
    store[kind] = recordTombstone(store[kind], key, { keyField: KEY_FIELD, deletedAt, limit: KIND_LIMITS[kind] });
    await writeStore(store);
    return store[kind].find((t) => t[KEY_FIELD] === key) ?? null;
  });
}

/**
 * Record the tombstone of a local delete that has not committed yet: it
 * filters incoming copies here at once, but stays out of every export until
 * commitMediaTombstone. Withdraw a failed delete with clearMediaTombstone and
 * the returned `deletedAt`. Resolves the recorded tombstone.
 */
export function beginMediaTombstone(kind, key) {
  assertKind(kind);
  assertKey(kind, key);
  return queueWrite(async () => {
    const store = await readStore();
    store[kind] = recordTombstone(store[kind], key, { keyField: KEY_FIELD, limit: KIND_LIMITS[kind] });
    const tombstone = store[kind].find((t) => t[KEY_FIELD] === key) ?? null;
    if (tombstone) {
      store.inFlight[kind] = [...store.inFlight[kind].filter((t) => t[KEY_FIELD] !== key), tombstone];
    }
    await writeStore(store);
    return tombstone;
  });
}

/** The delete committed: its tombstone becomes exportable. Resolves true when a marker was removed. */
export function commitMediaTombstone(kind, tombstone) {
  assertKind(kind);
  return queueWrite(async () => {
    const store = await readStore();
    const stamp = stampOf(tombstone);
    const kept = store.inFlight[kind].filter((t) => stampOf(t) !== stamp);
    if (kept.length === store.inFlight[kind].length) return false;
    store.inFlight[kind] = kept;
    await writeStore(store);
    return true;
  });
}

// Undo a tombstone recorded for a delete that then failed, or retire one the
// item outlived (restored, re-created). `deletedAt` clears only that exact
// delete: a newer delete recorded since the caller looked must survive.
// Resolves true when a tombstone was removed.
export function clearMediaTombstone(kind, key, { deletedAt = null } = {}) {
  assertKind(kind);
  return queueWrite(async () => {
    const store = await readStore();
    const current = store[kind].find((t) => t[KEY_FIELD] === key);
    if (!current || (deletedAt !== null && current.deletedAt !== deletedAt)) return false;
    store[kind] = clearTombstone(store[kind], key, KEY_FIELD);
    await writeStore(store);
    return true;
  });
}

/** Every tombstone of `kind`, in-flight ones included: the set that filters rows on this machine. */
export async function listMediaTombstones(kind) {
  assertKind(kind);
  return (await readStore())[kind];
}

/** The tombstones a peer may receive: those of committed deletes only. */
export async function listExportableMediaTombstones(kind) {
  assertKind(kind);
  const store = await readStore();
  const pending = new Set(inFlightStamps(store, kind).map(stampOf));
  return store[kind].filter((t) => !pending.has(stampOf(t)));
}

/** Tombstones of local deletes that have not committed (a crash leaves these behind). */
export async function listInFlightMediaTombstones(kind) {
  assertKind(kind);
  return inFlightStamps(await readStore(), kind);
}

export function mergeMediaTombstones(kind, remote) {
  assertKind(kind);
  return queueWrite(async () => {
    const store = await readStore();
    const before = new Set(store[kind].map((t) => `${t[KEY_FIELD]}@${t.deletedAt}`));
    const { merged, changed } = mergeTombstones(store[kind], remote, { keyField: KEY_FIELD, limit: KIND_LIMITS[kind] });
    if (changed) {
      store[kind] = merged;
      await writeStore(store);
    }
    return { added: merged.filter((t) => !before.has(`${t[KEY_FIELD]}@${t.deletedAt}`)) };
  });
}

/**
 * Each tombstoned key of `kind` with its deletion time (epoch ms). Image names
 * can be re-used (a re-rendered handoff or preview frame), so a pull compares
 * the incoming copy's stamp against it rather than blocking the name forever.
 */
export async function mediaTombstoneStamps(kind) {
  assertKind(kind);
  return new Map((await readStore())[kind].map((t) => [t[KEY_FIELD], Date.parse(t.deletedAt)]));
}

