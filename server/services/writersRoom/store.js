/**
 * Writers Room — storage backend dispatcher (#1017).
 *
 * Folders, works (+ decomposed draft versions), and exercises used to live in a
 * bespoke file layout (folders.json, exercises.json, per-work manifest.json). As
 * of #1017 their METADATA lives in PostgreSQL (writers_room_folders /
 * writers_room_works / writers_room_draft_versions / writers_room_exercises).
 * The draft PROSE BODIES stay on disk (file-primary) — local.js still owns the
 * .md read/write; this dispatcher only routes the metadata.
 *
 * The public surface (folders/works/exercises CRUD) is identical across both
 * backends, so local.js calls `store()` and keeps its API unchanged:
 *
 *   - PostgreSQL (./db.js) for normal installs.
 *   - File backend only under MEMORY_BACKEND=file or NODE_ENV=test (both
 *     UNSUPPORTED for production). The file backend reproduces the legacy
 *     on-disk JSON format so tests boot without a DB exactly as before.
 *
 * Works FEDERATE across peers as of #1565 via the per-record peer-sync push
 * pipeline (not the 60s snapshot loop), so this dispatcher also routes the
 * federation primitives (readWork includeDeleted, listWorkIds includeDeleted,
 * mergeWorksFromSync, pruneTombstonedWorks) to whichever backend is active —
 * both implement the same LWW/tombstone semantics from syncLogic.js. There is
 * still NO mutation epoch here: works ride per-record pushes, not the snapshot
 * checksum a storage swap would invalidate.
 *
 * The first PG-backed call runs a one-time, marker-gated import of the legacy
 * data/writers-room file store into the tables (migrateWritersRoomToDB).
 */

import { readFile, readdir } from 'fs/promises';
import { atomicWrite, ensureDir, readJSONFile, safeJSONParse } from '../../lib/fileUtils.js';
import { checkHealth, ensureSchema } from '../../lib/db.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  maybeJournalBeforeOverwrite, setSyncBaseHash, contentHashForRecord, flushBaseHashes,
} from '../../lib/conflictJournal.js';
import { WRITERS_ROOM_WORK_KIND, mergeWorkRecord } from './syncLogic.js';
import {
  WORK_ID_RE, wrRoot, wrFoldersFile, wrExercisesFile, wrWorksDir, wrManifestPath,
} from './_shared.js';

function isFileBackend() {
  return process.env.MEMORY_BACKEND === 'file' || process.env.NODE_ENV === 'test';
}

// --- File backend (escape hatch / tests): the legacy on-disk JSON format ---
// Reproduces local.js's original storage primitives verbatim so an install on
// the file escape hatch (and every test that boots without a DB) behaves
// identically to the pre-#1017 file layout.
function makeFileBackend() {
  const loadFolders = async () => {
    await ensureDir(wrRoot());
    const raw = await readJSONFile(wrFoldersFile(), []);
    return Array.isArray(raw) ? raw : [];
  };
  const saveFolders = async (folders) => {
    await ensureDir(wrRoot());
    await atomicWrite(wrFoldersFile(), folders);
  };
  const loadExercises = async () => {
    await ensureDir(wrRoot());
    const raw = await readJSONFile(wrExercisesFile(), []);
    return Array.isArray(raw) ? raw : [];
  };
  const saveExercises = async (exercises) => {
    await ensureDir(wrRoot());
    await atomicWrite(wrExercisesFile(), exercises);
  };
  const loadManifest = async (workId) => {
    const path = wrManifestPath(workId);
    const content = await readFile(path, 'utf-8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (content === null) return null;
    // Surface corrupted manifests as a deterministic CORRUPTED_MANIFEST 500 (the
    // pre-#1017 file behavior) so listWorks can drop the work without masking
    // the issue and direct callers get an actionable error, not a raw SyntaxError.
    const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context: path });
    if (parsed === null) {
      console.warn(`⚠️ wr: corrupted manifest at ${path} (work ${workId})`);
      throw new ServerError(`Corrupted writers-room manifest for ${workId}`, {
        status: 500, code: 'CORRUPTED_MANIFEST', context: { workId },
      });
    }
    return parsed;
  };
  const saveManifest = async (workId, manifest) => {
    await ensureDir(`${wrWorksDir()}/${workId}/drafts`);
    await atomicWrite(wrManifestPath(workId), manifest);
  };
  const listWorkIds = async () => {
    await ensureDir(wrWorksDir());
    const entries = await readdir(wrWorksDir(), { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && WORK_ID_RE.test(e.name)).map((e) => e.name);
  };

  return {
    name: 'file',
    // folders
    listFolders: loadFolders,
    writeFolder: async (folder) => {
      const folders = await loadFolders();
      const idx = folders.findIndex((f) => f.id === folder.id);
      if (idx >= 0) folders[idx] = folder; else folders.push(folder);
      await saveFolders(folders);
    },
    deleteFolder: async (id) => saveFolders((await loadFolders()).filter((f) => f.id !== id)),
    // exercises
    listExercises: loadExercises,
    writeExercise: async (exercise) => {
      const all = await loadExercises();
      const idx = all.findIndex((e) => e.id === exercise.id);
      if (idx >= 0) all[idx] = exercise; else all.push(exercise);
      await saveExercises(all);
    },
    // works (manifest carries its own drafts[] in the file format). A
    // soft-deleted work (tombstone) stays on disk; readWork/listWorks/listWorkIds
    // filter it out unless includeDeleted, mirroring the PG backend's
    // `WHERE deleted = FALSE`.
    readWork: async (id, { includeDeleted = false } = {}) => {
      const manifest = await loadManifest(id);
      if (!manifest) return null;
      if (!includeDeleted && manifest.deleted === true) return null;
      return manifest;
    },
    listWorkIds: async ({ includeDeleted = false } = {}) => {
      const ids = await listWorkIds();
      if (includeDeleted) return ids;
      // Load manifests concurrently (mirrors listWorks below) to filter tombstones.
      const manifests = await Promise.all(ids.map((id) => loadManifest(id).catch(() => null)));
      return ids.filter((_, i) => manifests[i] && manifests[i].deleted !== true);
    },
    listWorks: async () => {
      const ids = await listWorkIds();
      // Tolerate a corrupted manifest per work (drop it from the listing) so one
      // bad work doesn't 500 the whole library — the pre-#1017 file behavior.
      // Re-throw anything else (permission errors, EIO) — masking those would
      // hide a real outage.
      const manifests = await Promise.all(ids.map((id) => loadManifest(id).catch((err) => {
        if (err?.code === 'CORRUPTED_MANIFEST') {
          console.warn(`⚠️ wr: dropped work ${id} from listing — corrupted manifest`);
          return null;
        }
        throw err;
      })));
      return manifests.filter((m) => m != null && m.deleted !== true);
    },
    writeWork: async (manifest) => { await saveManifest(manifest.id, manifest); return manifest; },
    deleteWork: async (id) => {
      // Soft-delete tombstone (#1565) so the deletion federates — mirror the PG
      // backend. Leave the .md bodies on disk until hard-prune. Idempotent.
      const manifest = await loadManifest(id).catch(() => null);
      if (!manifest || manifest.deleted === true) return;
      const now = new Date().toISOString();
      await saveManifest(id, { ...manifest, deleted: true, deletedAt: now, updatedAt: now });
    },
    mergeWorksFromSync: async (remoteWorks, { source = { via: 'sync', peerId: null } } = {}) => {
      if (!Array.isArray(remoteWorks)) return { applied: false, count: 0 };
      let changed = 0;
      for (const remote of remoteWorks) {
        const local = await loadManifest(remote?.id).catch(() => null);
        const { next, inserted, remoteWins, changed: didChange } = mergeWorkRecord(local, remote);
        if (!next) continue;
        if (!inserted && (!remoteWins || !didChange)) continue;
        if (!inserted) {
          await maybeJournalBeforeOverwrite({ kind: WRITERS_ROOM_WORK_KIND, id: next.id, local, remote: next, source });
        }
        await saveManifest(next.id, next);
        await setSyncBaseHash(WRITERS_ROOM_WORK_KIND, next.id, contentHashForRecord(WRITERS_ROOM_WORK_KIND, next));
        changed += 1;
      }
      await flushBaseHashes();
      return changed === 0 ? { applied: false, count: 0 } : { applied: true, count: changed };
    },
    pruneTombstonedWorks: async (olderThanMs) => {
      if (!Number.isFinite(olderThanMs)) return { pruned: 0, ids: [] };
      const ids = await listWorkIds();
      const manifests = await Promise.all(ids.map((id) => loadManifest(id).catch(() => null)));
      const out = ids.filter((_, i) => {
        const m = manifests[i];
        const deletedMs = m?.deleted === true ? Date.parse(m.deletedAt || '') : NaN;
        return Number.isFinite(deletedMs) && deletedMs < olderThanMs;
      });
      // The facade (sync.js) rm's each id's dir (manifest + bodies) and evicts the
      // base hash — uniform with the PG backend, whose rows are dropped here.
      return { pruned: out.length, ids: out };
    },
    listDraftVersionsForCoherence: async () => {
      const ids = await listWorkIds();
      const out = [];
      for (const id of ids) {
        const m = await loadManifest(id).catch(() => null);
        if (!m || m.deleted === true) continue;
        for (const d of m?.drafts || []) {
          out.push({ id: d.id, workId: id, contentFile: d.contentFile, contentHash: d.contentHash });
        }
      }
      return out;
    },
  };
}

// --- PostgreSQL backend: pure leaf I/O from ./db.js ---
function makePgBackend(db) {
  return { name: 'postgres', ...db };
}

async function pgBackend() {
  const health = await checkHealth();
  if (!health.connected) {
    throw new Error('Writers Room requires PostgreSQL — run `npm run setup:db` (dev/test only: set MEMORY_BACKEND=file for the unsupported file backend)');
  }
  await ensureSchema();
  const { migrateWritersRoomToDB } = await import('../../scripts/migrateWritersRoomToDB.js');
  await migrateWritersRoomToDB();
  const db = await import('./db.js');
  return makePgBackend(db);
}

// Memoize the backend-selection PROMISE (not just the result) so two concurrent
// first calls — e.g. the boot warm racing a request — don't both import the PG
// module and run the migration twice.
let backend = null;
let selecting = null;

export function _resetWritersRoomStore() {
  backend = null;
  selecting = null;
}

function getBackend() {
  if (backend) return Promise.resolve(backend);
  if (!selecting) {
    selecting = (isFileBackend() ? Promise.resolve(makeFileBackend()) : pgBackend())
      .then((b) => { backend = b; return b; })
      .finally(() => { selecting = null; });
  }
  return selecting;
}

/** The Writers Room metadata store — backend resolved lazily per call. */
export function writersRoomStore() {
  return {
    getBackendName: () => backend?.name ?? null,
    listFolders: async () => (await getBackend()).listFolders(),
    writeFolder: async (folder) => (await getBackend()).writeFolder(folder),
    deleteFolder: async (id) => (await getBackend()).deleteFolder(id),
    listExercises: async () => (await getBackend()).listExercises(),
    writeExercise: async (exercise) => (await getBackend()).writeExercise(exercise),
    readWork: async (id, opts) => (await getBackend()).readWork(id, opts),
    listWorkIds: async (opts) => (await getBackend()).listWorkIds(opts),
    listWorks: async () => (await getBackend()).listWorks(),
    writeWork: async (manifest) => (await getBackend()).writeWork(manifest),
    deleteWork: async (id) => (await getBackend()).deleteWork(id),
    mergeWorksFromSync: async (remoteWorks, opts) => (await getBackend()).mergeWorksFromSync(remoteWorks, opts),
    pruneTombstonedWorks: async (olderThanMs) => (await getBackend()).pruneTombstonedWorks(olderThanMs),
    listDraftVersionsForCoherence: async () => (await getBackend()).listDraftVersionsForCoherence(),
  };
}
