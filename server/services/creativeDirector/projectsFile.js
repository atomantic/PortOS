/**
 * Creative Director — file-backed project store (escape-hatch / test backend).
 *
 * Persists to data/creative-director-projects.json (array, atomicWrite). This
 * is the ORIGINAL storage; as of Phase 3 (#997) PostgreSQL is the default and
 * this backend is reachable only via the MEMORY_BACKEND=file escape hatch or
 * NODE_ENV=test — same posture as the memory backend (see memoryBackend.js).
 * The dispatcher in local.js picks between this and projectsDB.js.
 *
 * All mutation semantics live in projectsLogic.js so this backend and the PG
 * backend can't drift; this module only does load/find/persist.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import { createCollection } from '../mediaCollections.js';
import {
  trimRuns,
  buildProjectRecord,
  applyProjectPatch,
  applyTreatment,
  applySceneUpdate,
  appendRun,
  applyRunUpdate,
} from './projectsLogic.js';

const PROJECTS_FILE = join(PATHS.data, 'creative-director-projects.json');

async function loadAll() {
  const raw = await readJSONFile(PROJECTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

async function saveAll(projects) {
  // Defense for first-run on a fresh checkout where data/ may not exist yet.
  await ensureDir(PATHS.data);
  // Enforce the runs[] cap at the single write chokepoint so every mutator
  // shrinks legacy over-cap arrays on first save without each having to remember.
  for (const p of projects) {
    if (Array.isArray(p?.runs)) p.runs = trimRuns(p.runs);
  }
  await atomicWrite(PROJECTS_FILE, projects);
}

export async function listProjects() {
  return loadAll();
}

export async function getProject(id) {
  const all = await loadAll();
  return all.find((p) => p.id === id) || null;
}

export async function createProject(input) {
  const id = `cd-${randomUUID()}`;
  const now = new Date().toISOString();
  // Auto-create a media collection scoped to this project. All segment renders
  // + the final stitched output land in here.
  const collection = await createCollection({ name: `Creative Director: ${input.name}`, description: `Auto-created for project ${id}` });
  const project = buildProjectRecord(input, { id, now, collectionId: collection.id });
  const all = await loadAll();
  all.push(project);
  await saveAll(all);
  console.log(`🎬 Created Creative Director project: ${id} (${input.name})`);
  return project;
}

export async function updateProject(id, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  all[idx] = applyProjectPatch(all[idx], patch);
  await saveAll(all);
  return all[idx];
}

export async function deleteProject(id) {
  const all = await loadAll();
  const next = all.filter((p) => p.id !== id);
  if (next.length === all.length) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  await saveAll(next);
  return { ok: true };
}

export async function setTreatment(id, treatmentInput) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  all[idx] = applyTreatment(all[idx], treatmentInput);
  await saveAll(all);
  return all[idx];
}

export async function updateScene(id, sceneId, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { project, updated } = applySceneUpdate(all[idx], sceneId, patch);
  all[idx] = project;
  await saveAll(all);
  return updated;
}

export async function recordRun(id, runEntry) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { project, run } = appendRun(all[idx], runEntry);
  all[idx] = project;
  await saveAll(all);
  return run;
}

export async function updateRun(id, runId, patch) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const { project, updated } = applyRunUpdate(all[idx], runId, patch);
  if (updated === null) return null;
  all[idx] = project;
  await saveAll(all);
  return updated;
}
