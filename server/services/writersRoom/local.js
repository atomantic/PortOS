/**
 * Writers Room — file-backed storage for folders, works, drafts, and exercises.
 *
 * Layout under data/writers-room/:
 *   folders.json
 *   exercises.json
 *   works/<workId>/manifest.json
 *   works/<workId>/drafts/<draftVersionId>.md
 *
 * Manifest holds work metadata + the active draft's metadata + the version
 * history; draft bodies live as .md files so long prose stays out of the JSON.
 *
 * This module is the only writer for data/writers-room/. See
 * docs/features/writers-room.md for the full data model.
 */

import { join } from 'path';
import { randomUUID, createHash } from 'crypto';
import { readFile, rm, readdir } from 'fs/promises';
import { PATHS, atomicWrite, ensureDir, readJSONFile, safeJSONParse } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { WORK_KINDS, WORK_STATUSES } from '../../lib/writersRoomPresets.js';

// Paths are resolved lazily so tests can swap PATHS.data via vi.mock without
// the module-load snapshot freezing them at import time.
const root = () => join(PATHS.data, 'writers-room');
const foldersFile = () => join(root(), 'folders.json');
const exercisesFile = () => join(root(), 'exercises.json');
const worksDir = () => join(root(), 'works');

const WORK_ID_RE = /^wr-work-[0-9a-f-]+$/i;
const DRAFT_ID_RE = /^wr-draft-[0-9a-f-]+$/i;

function nowIso() {
  return new Date().toISOString();
}

function notFound(what) {
  return new ServerError(`${what} not found`, { status: 404, code: 'NOT_FOUND' });
}

function badRequest(message) {
  return new ServerError(message, { status: 400, code: 'VALIDATION_ERROR' });
}

function workDir(workId) {
  if (!WORK_ID_RE.test(workId)) throw badRequest('Invalid work id');
  return join(worksDir(), workId);
}

function draftPath(workId, draftId) {
  if (!DRAFT_ID_RE.test(draftId)) throw badRequest('Invalid draft id');
  return join(workDir(workId), 'drafts', `${draftId}.md`);
}

function manifestPath(workId) {
  return join(workDir(workId), 'manifest.json');
}

// ---------- text analysis ----------

export function countWords(text) {
  if (!text) return 0;
  const matches = String(text).trim().match(/\S+/g);
  return matches ? matches.length : 0;
}

export function contentHash(text) {
  return createHash('sha256').update(text || '').digest('hex');
}

/**
 * Build a segment index over Markdown-flavored prose.
 *
 * Splits on # / ## / ### headings (### collapses to scene; the outline panel
 * doesn't visually distinguish a separate "beat" tier in Phase 1). Anything
 * before the first heading becomes a "preamble" segment. No headings → one
 * "(untitled)" segment covers the whole body. Empty/missing text → empty
 * array (so a brand-new draft doesn't show a phantom segment in the outline).
 * The index powers the outline panel today and will anchor stale-analysis
 * detection in later phases.
 */
function segId(seq) {
  return `seg-${String(seq).padStart(3, '0')}`;
}

export function buildSegmentIndex(text) {
  // Whitespace-only counts as empty too — otherwise '   ' would emit a
  // phantom "(untitled)" segment in the outline panel of a brand-new draft
  // where the user has only hit space/enter a couple times.
  if (!text || !String(text).trim()) return [];
  const headingRe = /^(#{1,3})\s+(.+)$/gm;
  const matches = [];
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({ index: m.index, hashes: m[1], heading: m[2].trim() });
  }
  let seq = 0;
  if (matches.length === 0) {
    return [{ id: segId(++seq), kind: 'paragraph', heading: '(untitled)', start: 0, end: text.length, wordCount: countWords(text) }];
  }
  const segments = [];
  if (matches[0].index > 0 && text.slice(0, matches[0].index).trim().length > 0) {
    segments.push({
      id: segId(++seq), kind: 'paragraph', heading: '(preamble)',
      start: 0, end: matches[0].index, wordCount: countWords(text.slice(0, matches[0].index)),
    });
  }
  matches.forEach((match, i) => {
    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    segments.push({
      id: segId(++seq),
      kind: match.hashes.length === 1 ? 'chapter' : 'scene',
      heading: match.heading,
      start,
      end,
      wordCount: countWords(text.slice(start, end)),
    });
  });
  return segments;
}

// ---------- folder CRUD ----------

async function loadFolders() {
  await ensureDir(root());
  const raw = await readJSONFile(foldersFile(), []);
  return Array.isArray(raw) ? raw : [];
}

async function saveFolders(folders) {
  await ensureDir(root());
  await atomicWrite(foldersFile(), folders);
}

export async function listFolders() {
  return loadFolders();
}

export async function createFolder({ name, parentId = null, sortOrder = 0 }) {
  if (!name || !name.trim()) throw badRequest('Folder name required');
  const folders = await loadFolders();
  if (parentId && !folders.find((f) => f.id === parentId)) throw notFound('Parent folder');
  const folder = {
    id: `wr-folder-${randomUUID()}`,
    parentId,
    name: name.trim(),
    sortOrder,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  folders.push(folder);
  await saveFolders(folders);
  return folder;
}

export async function deleteFolder(id) {
  const folders = await loadFolders();
  if (!folders.find((f) => f.id === id)) throw notFound('Folder');
  const works = await listWorks();
  if (works.some((w) => w.folderId === id)) {
    throw badRequest('Folder is not empty — move or delete its works first');
  }
  if (folders.some((f) => f.parentId === id)) {
    throw badRequest('Folder has subfolders — delete or reparent them first');
  }
  await saveFolders(folders.filter((f) => f.id !== id));
  return { ok: true };
}

// ---------- work CRUD ----------

async function loadManifest(workId) {
  const path = manifestPath(workId);
  const content = await readFile(path, 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (content === null) return null;
  // Surface corrupted manifests as a deterministic 500 with a clear code so
  // listWorks can drop the work without masking the underlying issue, and
  // direct callers (getWork) get an actionable error instead of a raw
  // SyntaxError bubbling out of JSON.parse.
  const parsed = safeJSONParse(content, null, { allowArray: false, logError: true, context: path });
  if (parsed === null) {
    // Log the absolute path server-side for debugging, but keep it OUT of
    // the ServerError — errorHandler ships both message AND context to the
    // client response body, so anything in context leaks to the UI.
    console.warn(`⚠️ wr: corrupted manifest at ${path} (work ${workId})`);
    throw new ServerError(`Corrupted writers-room manifest for ${workId}`, {
      status: 500,
      code: 'CORRUPTED_MANIFEST',
      context: { workId },
    });
  }
  return parsed;
}

async function saveManifest(workId, manifest) {
  await ensureDir(join(workDir(workId), 'drafts'));
  await atomicWrite(manifestPath(workId), manifest);
}

// Lazy-import to break a circular dep (mediaCollections doesn't import us, but
// importing it at module-top would still be fine; the function-level import
// just keeps this helper self-contained next to its caller).
export async function ensureWorkMediaCollection(workId) {
  const manifest = await getWork(workId);
  const { getCollection, createCollection, ERR_NOT_FOUND } = await import('../mediaCollections.js');
  if (manifest.mediaCollectionId) {
    const existing = await getCollection(manifest.mediaCollectionId).catch((err) => {
      // The collection was deleted out-of-band — drop the stale id and recreate.
      if (err?.code === ERR_NOT_FOUND) return null;
      throw err;
    });
    if (existing) return existing;
  }
  const collection = await createCollection({
    name: `Writers Room: ${manifest.title}`.slice(0, 80),
    description: `Auto-generated images for "${manifest.title}"`,
  });
  await saveManifest(workId, { ...manifest, mediaCollectionId: collection.id, updatedAt: nowIso() });
  return collection;
}

async function listWorkIds() {
  await ensureDir(worksDir());
  const entries = await readdir(worksDir(), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && WORK_ID_RE.test(e.name)).map((e) => e.name);
}

export async function listWorks() {
  const ids = await listWorkIds();
  // Tolerate KNOWN failure modes per work (corrupted JSON, missing file) so
  // one bad work doesn't 500 the whole library. Re-throw anything else
  // (permission errors, EIO, programming bugs) — silently swallowing those
  // would mask real outages. ENOENT bubbles as null from loadManifest itself,
  // not as a thrown error, so we only need to special-case CORRUPTED_MANIFEST.
  const manifests = await Promise.all(ids.map((id) => loadManifest(id).catch((err) => {
    if (err?.code === 'CORRUPTED_MANIFEST') {
      console.warn(`⚠️ wr: dropped work ${id} from listing — corrupted manifest`);
      return null;
    }
    throw err;
  })));
  return manifests
    .filter(Boolean)
    .map((manifest) => {
      const activeDraft = (manifest.drafts || []).find((d) => d.id === manifest.activeDraftVersionId);
      return {
        id: manifest.id,
        folderId: manifest.folderId,
        title: manifest.title,
        kind: manifest.kind,
        status: manifest.status,
        activeDraftVersionId: manifest.activeDraftVersionId,
        wordCount: activeDraft?.wordCount ?? 0,
        draftCount: (manifest.drafts || []).length,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
      };
    })
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getWork(id) {
  const manifest = await loadManifest(id);
  if (!manifest) throw notFound('Work');
  return manifest;
}

async function readDraftFile(workId, draftId) {
  return readFile(draftPath(workId, draftId), 'utf-8').catch((err) => {
    if (err.code === 'ENOENT') return '';
    throw err;
  });
}

export async function getWorkWithBody(id) {
  const manifest = await getWork(id);
  const activeId = manifest.activeDraftVersionId;
  if (!activeId) return { manifest, body: '' };
  return { manifest, body: await readDraftFile(id, activeId) };
}

export async function createWork({ folderId = null, title, kind = 'short-story' }) {
  if (!title || !title.trim()) throw badRequest('Work title required');
  if (!WORK_KINDS.includes(kind)) throw badRequest(`Invalid kind: ${kind}`);
  if (folderId) {
    const folders = await loadFolders();
    if (!folders.find((f) => f.id === folderId)) throw notFound('Folder');
  }
  const id = `wr-work-${randomUUID()}`;
  const draftId = `wr-draft-${randomUUID()}`;
  const now = nowIso();
  await ensureDir(join(workDir(id), 'drafts'));
  await atomicWrite(draftPath(id, draftId), '');
  const manifest = {
    id,
    folderId,
    title: title.trim(),
    kind,
    status: 'drafting',
    activeDraftVersionId: draftId,
    drafts: [
      {
        id: draftId,
        label: 'Draft 1',
        contentFile: `drafts/${draftId}.md`,
        contentHash: contentHash(''),
        wordCount: 0,
        segmentIndex: [],
        createdAt: now,
        createdFromVersionId: null,
      },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await saveManifest(id, manifest);
  return manifest;
}

export async function updateWork(id, patch) {
  const manifest = await getWork(id);
  const allowed = ['title', 'folderId', 'kind', 'status'];
  const next = { ...manifest, updatedAt: nowIso() };
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (key === 'kind' && !WORK_KINDS.includes(patch.kind)) throw badRequest(`Invalid kind: ${patch.kind}`);
    if (key === 'status' && !WORK_STATUSES.includes(patch.status)) throw badRequest(`Invalid status: ${patch.status}`);
    next[key] = patch[key];
  }
  // Trim title and reject if it becomes empty after trim — keeps parity with
  // createWork's "title required" guard so a PATCH can't blank a title out.
  if (patch.title !== undefined) {
    const trimmed = String(patch.title ?? '').trim();
    if (!trimmed) throw badRequest('Work title required');
    next.title = trimmed;
  }
  // folderId can be set to a real folder id or to null (unfile the work).
  // Anything else would orphan it from the library tree.
  if (patch.folderId !== undefined && patch.folderId !== null) {
    const folders = await loadFolders();
    if (!folders.find((f) => f.id === patch.folderId)) throw notFound('Folder');
  }
  await saveManifest(id, next);
  return next;
}

export async function deleteWork(id) {
  // 404 the caller if the manifest is missing; rm() with force:true would
  // silently succeed on a non-existent dir and the user gets no signal.
  // Tolerate CORRUPTED_MANIFEST so a user can recover from on-disk corruption
  // by deleting the work via the API/UI instead of resorting to `rm -rf`.
  await getWork(id).catch((err) => {
    if (err?.code === 'CORRUPTED_MANIFEST') {
      console.warn(`⚠️  wr: deleting work ${id} despite corrupted manifest`);
      return;
    }
    throw err;
  });
  await rm(workDir(id), { recursive: true, force: true });
  return { ok: true };
}

// ---------- draft body / version snapshots ----------

function buildDraftMeta(text, base = {}) {
  return {
    ...base,
    contentHash: contentHash(text),
    wordCount: countWords(text),
    segmentIndex: buildSegmentIndex(text),
  };
}

export async function saveDraftBody(workId, body) {
  const manifest = await getWork(workId);
  const activeId = manifest.activeDraftVersionId;
  if (!activeId) throw badRequest('Work has no active draft');
  const text = String(body ?? '');
  await atomicWrite(draftPath(workId, activeId), text);
  const draftIdx = manifest.drafts.findIndex((d) => d.id === activeId);
  if (draftIdx < 0) throw notFound('Active draft');
  manifest.drafts[draftIdx] = buildDraftMeta(text, manifest.drafts[draftIdx]);
  manifest.updatedAt = nowIso();
  await saveManifest(workId, manifest);
  console.log(`📝 wr: saved draft ${activeId.slice(0, 14)}… (${manifest.drafts[draftIdx].wordCount} words)`);
  return { manifest, body: text };
}

export async function snapshotDraft(workId, { label } = {}) {
  const { manifest, body } = await getWorkWithBody(workId);
  const newDraftId = `wr-draft-${randomUUID()}`;
  const fromId = manifest.activeDraftVersionId;
  const draftLabel = label || `Draft ${manifest.drafts.length + 1}`;
  await atomicWrite(draftPath(workId, newDraftId), body);
  manifest.drafts.push(buildDraftMeta(body, {
    id: newDraftId,
    label: draftLabel,
    contentFile: `drafts/${newDraftId}.md`,
    createdAt: nowIso(),
    createdFromVersionId: fromId,
  }));
  manifest.activeDraftVersionId = newDraftId;
  manifest.updatedAt = nowIso();
  await saveManifest(workId, manifest);
  console.log(`📚 wr: snapshot ${draftLabel} for ${manifest.title}`);
  return manifest;
}

export async function setActiveDraft(workId, draftId) {
  const manifest = await getWork(workId);
  if (!manifest.drafts.find((d) => d.id === draftId)) throw notFound('Draft version');
  manifest.activeDraftVersionId = draftId;
  manifest.updatedAt = nowIso();
  await saveManifest(workId, manifest);
  return manifest;
}

export async function getDraftBody(workId, draftId) {
  const manifest = await getWork(workId);
  if (!manifest.drafts.find((d) => d.id === draftId)) throw notFound('Draft version');
  return readDraftFile(workId, draftId);
}

// ---------- exercise sessions ----------

async function loadExercises() {
  await ensureDir(root());
  const raw = await readJSONFile(exercisesFile(), []);
  return Array.isArray(raw) ? raw : [];
}

async function saveExercises(exercises) {
  await ensureDir(root());
  await atomicWrite(exercisesFile(), exercises);
}

export async function listExercises({ workId } = {}) {
  const all = await loadExercises();
  const filtered = workId ? all.filter((e) => e.workId === workId) : all;
  return filtered.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
}

function settled(exercise) {
  return exercise.status === 'finished' || exercise.status === 'discarded';
}

export async function createExercise({ workId = null, prompt = '', durationSeconds = 600, startingWords = 0 }) {
  if (workId) await getWork(workId); // 404 if missing
  const exercise = {
    id: `wr-ex-${randomUUID()}`,
    workId,
    prompt: String(prompt || '').trim(),
    durationSeconds: Math.max(60, Math.min(durationSeconds, 60 * 60)),
    startingWords,
    endingWords: null,
    wordsAdded: null,
    appendedText: null,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
  };
  const all = await loadExercises();
  all.push(exercise);
  await saveExercises(all);
  return exercise;
}

export async function finishExercise(id, { endingWords, appendedText = null } = {}) {
  const all = await loadExercises();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) throw notFound('Exercise');
  if (settled(all[idx])) throw badRequest('Exercise is already settled');
  // Default missing endingWords to startingWords so wordsAdded never goes
  // negative when the caller forgets to send it; clamp the delta as a final
  // backstop for the case where the user backspaces past their starting count.
  const startingWords = all[idx].startingWords || 0;
  const resolvedEnding = endingWords ?? startingWords;
  const wordsAdded = Math.max(0, resolvedEnding - startingWords);
  const finished = {
    ...all[idx],
    endingWords: resolvedEnding,
    wordsAdded,
    appendedText: appendedText ?? null,
    status: 'finished',
    finishedAt: nowIso(),
  };
  all[idx] = finished;
  await saveExercises(all);
  return finished;
}

export async function discardExercise(id) {
  const all = await loadExercises();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) throw notFound('Exercise');
  if (settled(all[idx])) throw badRequest('Exercise is already settled');
  all[idx] = { ...all[idx], status: 'discarded', finishedAt: nowIso() };
  await saveExercises(all);
  return all[idx];
}
