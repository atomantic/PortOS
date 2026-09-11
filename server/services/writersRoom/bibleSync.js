/** File-primary Writers Room bibles: optional peer assets, independent LWW per file. */
import { z } from 'zod';
import { withBibleWrite } from '../bibleStore.js';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { atomicWrite } from '../../lib/fileUtils.js';
import { compareNewerWins } from '../../lib/lwwTimestamp.js';
import { isPlainObject } from '../../lib/objects.js';
import { journalConflict } from '../../lib/conflictJournal.js';
import { WORK_ID_RE, wrWorkDir } from './_shared.js';
import { emitRecordUpdated } from '../sharing/recordEvents.js';

export const BIBLE_FILES = Object.freeze({ character: 'characters', place: 'places', object: 'objects' });
export const BIBLE_CONFLICT_KINDS = Object.freeze({ character: 'writersRoomCharacters', place: 'writersRoomPlaces', object: 'writersRoomObjects' });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const validTarget = (workId, kind) => typeof workId === 'string' && WORK_ID_RE.test(workId) && Object.hasOwn(BIBLE_FILES, kind);
export const workBiblePath = (workId, kind) => validTarget(workId, kind) ? join(wrWorkDir(workId), `${BIBLE_FILES[kind]}.json`) : null;
const timestampSchema = z.string().datetime({ offset: true });
const validDoc = (doc, kind) => isPlainObject(doc) && Array.isArray(doc[BIBLE_FILES[kind]]) && timestampSchema.safeParse(doc.updatedAt).success;
const parseDoc = (bytes, kind) => {
  const doc = JSON.parse(bytes.toString('utf8'));
  if (!validDoc(doc, kind)) throw new Error('Invalid Writers Room bible document');
  return doc;
};
const readBytes = (path) => readFile(path).catch((err) => {
  if (err.code === 'ENOENT') return null;
  throw err; // unreadable/corrupt local data must never be treated as absent
});

export async function buildWorkBibleManifest(work) {
  if (!WORK_ID_RE.test(work?.id || '') || work.deleted) return [];
  const manifest = [];
  for (const kind of Object.keys(BIBLE_FILES)) {
    const entry = await readBibleManifestEntry(work.id, kind).catch((err) => {
      console.error(`❌ Writers Room ${kind} bible unavailable for sync: ${err.message}`);
      return null; // omission cannot delete the receiver's file; other assets still ship
    });
    if (entry) manifest.push(entry);
  }
  return manifest;
}

async function readBibleManifestEntry(workId, kind) {
  const bytes = await readBytes(workBiblePath(workId, kind));
  if (!bytes) return null;
  const doc = parseDoc(bytes, kind);
  return { workId, kind, sha256: hash(bytes), updatedAt: doc.updatedAt };
}

export async function diffWorkBibleManifest(manifest, { onError = (err) => { throw err; } } = {}) {
  const missing = [];
  for (const entry of Array.isArray(manifest) ? manifest : []) {
    if (!validTarget(entry?.workId, entry?.kind) || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '') || !Number.isFinite(Date.parse(entry.updatedAt))) continue;
    const { workId, kind, sha256, updatedAt } = entry;
    const local = await readBibleManifestEntry(workId, kind).catch((err) => { onError(err); return false; });
    if (local === false) continue; // unreadable incumbent stays intact; process the other files
    if (!local || (local.sha256 !== sha256 && compareNewerWins(updatedAt, local.updatedAt))) {
      missing.push({ workId, kind, sha256, updatedAt });
    }
  }
  return missing;
}

/** Recheck the incumbent after download; a local edit during the pull still wins. */
export async function applyWorkBibleBytes(entry, bytes, source) {
  const path = workBiblePath(entry?.workId, entry?.kind);
  if (!path || hash(bytes) !== entry.sha256) return false;
  return withBibleWrite(path, () => commitWorkBible(entry, bytes, source, path));
}

async function commitWorkBible(entry, bytes, source, path) {
  const remote = parseDoc(bytes, entry.kind);
  if (remote.updatedAt !== entry.updatedAt) return false;
  const localBytes = await readBytes(path);
  if (localBytes) {
    if (hash(localBytes) === entry.sha256) return false;
    const local = parseDoc(localBytes, entry.kind);
    if (!compareNewerWins(remote.updatedAt, local.updatedAt)) return false;
    // Preserve the complete losing file, including fields unknown to this version.
    // Unlike record merges, file assets have no shared base: archive every replacement.
    await journalConflict({ kind: BIBLE_CONFLICT_KINDS[entry.kind], id: entry.workId, local, remote, source,
      hashes: { localHash: hash(localBytes), remoteHash: entry.sha256 } });
  }
  await atomicWrite(path, bytes);
  emitRecordUpdated('writersRoomWork', entry.workId);
  return true;
}

/** Conflict restore is a fresh whole-file edit, so it propagates like an authored bible. */
export async function restoreWorkBible(workId, kind, patch) {
  const path = workBiblePath(workId, kind);
  if (!path || !Array.isArray(patch?.[BIBLE_FILES[kind]])) throw new Error('Invalid Writers Room bible restore');
  const { getWorkForSync } = await import('./sync.js');
  const work = await getWorkForSync(workId);
  if (!work || work.deleted) throw Object.assign(new Error('Work not found'), { code: 'NOT_FOUND' });
  await withBibleWrite(path, async () => {
    const bytes = await readBytes(path);
    const local = bytes ? parseDoc(bytes, kind) : {};
    await atomicWrite(path, { ...local, ...patch, updatedAt: new Date().toISOString() });
  });
  emitRecordUpdated('writersRoomWork', workId);
}
