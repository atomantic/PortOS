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
import { readFile, writeFile, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { PATHS, atomicWrite, ensureDir, readJSONFile } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';

// Paths are resolved lazily so tests can swap PATHS.data via vi.mock without
// the module-load snapshot freezing them at import time.
const root = () => join(PATHS.data, 'writers-room');
const foldersFile = () => join(root(), 'folders.json');
const exercisesFile = () => join(root(), 'exercises.json');
const worksDir = () => join(root(), 'works');

const WORK_KINDS = ['novel', 'short-story', 'screenplay', 'essay', 'treatment', 'other'];
const WORK_STATUSES = ['idea', 'drafting', 'revision', 'adaptation', 'rendering', 'complete', 'archived'];
const EXERCISE_STATUSES = ['running', 'paused', 'finished', 'discarded'];

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
 * Segments are derived by splitting on headings (#, ##, ###) — anything before
 * the first heading becomes a "preamble" segment. If the draft has no headings,
 * one segment covers the whole body. Each segment carries character offsets,
 * a heading, kind, and word count. The index is the foundation for stale-
 * analysis detection in later phases; in Phase 1 it just powers the draft list
 * outline panel.
 */
export function buildSegmentIndex(text) {
  if (!text) return [];
  const headingRe = /^(#{1,3})\s+(.+)$/gm;
  const matches = [];
  let m;
  while ((m = headingRe.exec(text)) !== null) {
    matches.push({ index: m.index, hashes: m[1], heading: m[2].trim(), endOfLine: m.index + m[0].length });
  }
  if (matches.length === 0) {
    return [{ id: 'seg-001', kind: 'paragraph', heading: '(untitled)', start: 0, end: text.length, wordCount: countWords(text) }];
  }
  const segments = [];
  if (matches[0].index > 0) {
    const preamble = text.slice(0, matches[0].index);
    if (preamble.trim().length > 0) {
      segments.push({ id: 'seg-001', kind: 'paragraph', heading: '(preamble)', start: 0, end: matches[0].index, wordCount: countWords(preamble) });
    }
  }
  matches.forEach((match, i) => {
    const start = match.index;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const body = text.slice(start, end);
    const kind = match.hashes.length === 1 ? 'chapter' : match.hashes.length === 2 ? 'scene' : 'beat';
    segments.push({
      id: `seg-${String(segments.length + 1).padStart(3, '0')}`,
      kind,
      heading: match.heading,
      start,
      end,
      wordCount: countWords(body),
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

export async function updateFolder(id, patch) {
  const folders = await loadFolders();
  const idx = folders.findIndex((f) => f.id === id);
  if (idx < 0) throw notFound('Folder');
  const allowed = ['name', 'parentId', 'sortOrder'];
  const next = { ...folders[idx], updatedAt: nowIso() };
  for (const key of allowed) {
    if (patch[key] !== undefined) next[key] = patch[key];
  }
  if (next.name) next.name = String(next.name).trim();
  folders[idx] = next;
  await saveFolders(folders);
  return next;
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
  if (!existsSync(manifestPath(workId))) return null;
  const content = await readFile(manifestPath(workId), 'utf-8');
  return JSON.parse(content);
}

async function saveManifest(workId, manifest) {
  await ensureDir(join(workDir(workId), 'drafts'));
  await atomicWrite(manifestPath(workId), manifest);
}

async function listWorkIds() {
  await ensureDir(worksDir());
  const entries = await readdir(worksDir(), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && WORK_ID_RE.test(e.name)).map((e) => e.name);
}

export async function listWorks() {
  const ids = await listWorkIds();
  const works = [];
  for (const id of ids) {
    const manifest = await loadManifest(id).catch(() => null);
    if (!manifest) continue;
    const activeDraft = (manifest.drafts || []).find((d) => d.id === manifest.activeDraftVersionId);
    works.push({
      id: manifest.id,
      folderId: manifest.folderId,
      title: manifest.title,
      kind: manifest.kind,
      status: manifest.status,
      tags: manifest.tags || [],
      activeDraftVersionId: manifest.activeDraftVersionId,
      wordCount: activeDraft?.wordCount ?? 0,
      draftCount: (manifest.drafts || []).length,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    });
  }
  return works.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export async function getWork(id) {
  const manifest = await loadManifest(id);
  if (!manifest) throw notFound('Work');
  return manifest;
}

export async function getWorkWithBody(id) {
  const manifest = await getWork(id);
  const activeId = manifest.activeDraftVersionId;
  if (!activeId) return { manifest, body: '' };
  const file = draftPath(id, activeId);
  const body = existsSync(file) ? await readFile(file, 'utf-8') : '';
  return { manifest, body };
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
  await writeFile(draftPath(id, draftId), '');
  const manifest = {
    id,
    folderId,
    title: title.trim(),
    kind,
    status: 'drafting',
    tags: [],
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
    collectionId: null,
    creativeDirectorProjectIds: [],
    settings: {
      defaultAnalysisProviderId: null,
      defaultAnalysisModel: null,
      defaultImageModelId: null,
      defaultVideoModelId: null,
      renderAspectRatio: '16:9',
      renderQuality: 'draft',
    },
    createdAt: now,
    updatedAt: now,
  };
  await saveManifest(id, manifest);
  return manifest;
}

export async function updateWork(id, patch) {
  const manifest = await getWork(id);
  const allowed = ['title', 'folderId', 'kind', 'status', 'tags', 'collectionId', 'settings'];
  const next = { ...manifest, updatedAt: nowIso() };
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (key === 'kind' && !WORK_KINDS.includes(patch.kind)) throw badRequest(`Invalid kind: ${patch.kind}`);
    if (key === 'status' && !WORK_STATUSES.includes(patch.status)) throw badRequest(`Invalid status: ${patch.status}`);
    if (key === 'settings') {
      next.settings = { ...manifest.settings, ...patch.settings };
      continue;
    }
    next[key] = patch[key];
  }
  if (next.title) next.title = String(next.title).trim();
  await saveManifest(id, next);
  return next;
}

export async function deleteWork(id) {
  if (!existsSync(workDir(id))) throw notFound('Work');
  await rm(workDir(id), { recursive: true, force: true });
  return { ok: true };
}

// ---------- draft body / version snapshots ----------

export async function saveDraftBody(workId, body) {
  const manifest = await getWork(workId);
  const activeId = manifest.activeDraftVersionId;
  if (!activeId) throw badRequest('Work has no active draft');
  const text = String(body ?? '');
  await writeFile(draftPath(workId, activeId), text);
  const draftIdx = manifest.drafts.findIndex((d) => d.id === activeId);
  if (draftIdx < 0) throw notFound('Active draft');
  manifest.drafts[draftIdx] = {
    ...manifest.drafts[draftIdx],
    contentHash: contentHash(text),
    wordCount: countWords(text),
    segmentIndex: buildSegmentIndex(text),
  };
  manifest.updatedAt = nowIso();
  await saveManifest(workId, manifest);
  return { manifest, body: text };
}

export async function snapshotDraft(workId, { label } = {}) {
  const { manifest, body } = await getWorkWithBody(workId);
  const newDraftId = `wr-draft-${randomUUID()}`;
  const fromId = manifest.activeDraftVersionId;
  const driftLabel = label || `Draft ${manifest.drafts.length + 1}`;
  await writeFile(draftPath(workId, newDraftId), body);
  manifest.drafts.push({
    id: newDraftId,
    label: driftLabel,
    contentFile: `drafts/${newDraftId}.md`,
    contentHash: contentHash(body),
    wordCount: countWords(body),
    segmentIndex: buildSegmentIndex(body),
    createdAt: nowIso(),
    createdFromVersionId: fromId,
  });
  manifest.activeDraftVersionId = newDraftId;
  manifest.updatedAt = nowIso();
  await saveManifest(workId, manifest);
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
  const file = draftPath(workId, draftId);
  return existsSync(file) ? await readFile(file, 'utf-8') : '';
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
    pausedAt: null,
    finishedAt: null,
  };
  const all = await loadExercises();
  all.push(exercise);
  await saveExercises(all);
  return exercise;
}

export async function updateExercise(id, patch) {
  const all = await loadExercises();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) throw notFound('Exercise');
  const current = all[idx];
  if (current.status === 'finished' || current.status === 'discarded') {
    throw badRequest('Exercise is already settled');
  }
  const allowed = ['prompt', 'pausedAt', 'status'];
  const next = { ...current };
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (key === 'status' && !EXERCISE_STATUSES.includes(patch.status)) {
      throw badRequest(`Invalid status: ${patch.status}`);
    }
    next[key] = patch[key];
  }
  all[idx] = next;
  await saveExercises(all);
  return next;
}

export async function finishExercise(id, { endingWords, appendedText = null } = {}) {
  const all = await loadExercises();
  const idx = all.findIndex((e) => e.id === id);
  if (idx < 0) throw notFound('Exercise');
  const current = all[idx];
  const finished = {
    ...current,
    endingWords: endingWords ?? current.endingWords ?? 0,
    wordsAdded: (endingWords ?? 0) - (current.startingWords || 0),
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
  all[idx] = { ...all[idx], status: 'discarded', finishedAt: nowIso() };
  await saveExercises(all);
  return all[idx];
}

// Constants exported for validation/tests
export const CONSTANTS = { WORK_KINDS, WORK_STATUSES, EXERCISE_STATUSES };
