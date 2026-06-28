/**
 * Music Video — file-backed project store (escape-hatch / test backend).
 *
 * Persists to data/music-video-projects.json (array, atomicWrite). Reachable
 * only via MEMORY_BACKEND=file or NODE_ENV=test — PostgreSQL (projectsDB.js) is
 * the default. All mutation semantics live in projectsLogic.js so this backend
 * and the PG backend can't drift; this module only does load/find/persist.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { ServerError } from '../../lib/errorHandler.js';
import {
  buildProjectRecord,
  applyProjectPatch,
  setAudioAnalysis,
  addScene,
  applySceneUpdate,
  removeScene,
  reorderScenes,
} from './projectsLogic.js';

const PROJECTS_FILE = join(PATHS.data, 'music-video-projects.json');

async function loadAll() {
  const raw = await readJSONFile(PROJECTS_FILE, []);
  return Array.isArray(raw) ? raw : [];
}

async function saveAll(projects) {
  await ensureDir(PATHS.data);
  await atomicWrite(PROJECTS_FILE, projects);
}

export async function listProjects({ includeDeleted = false } = {}) {
  const all = await loadAll();
  return includeDeleted ? all : all.filter((p) => !p.deleted);
}

export async function getProject(id, { includeDeleted = false } = {}) {
  const all = await loadAll();
  const found = all.find((p) => p.id === id);
  if (!found) return null;
  return includeDeleted || !found.deleted ? found : null;
}

export async function createProject(input) {
  const id = `mv-${randomUUID()}`;
  const now = new Date().toISOString();
  const project = buildProjectRecord(input, { id, now });
  const all = await loadAll();
  all.push(project);
  await saveAll(all);
  console.log(`🎞️ Created Music Video project: ${id} (${input.name})`);
  return project;
}

// Locate a live (non-tombstoned) project for a user-facing mutator, or throw 404.
async function loadAllAndIndex(id) {
  const all = await loadAll();
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0 || all[idx].deleted) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return { all, idx };
}

export async function updateProject(id, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = applyProjectPatch(all[idx], patch);
  await saveAll(all);
  return all[idx];
}

export async function deleteProject(id) {
  const { all, idx } = await loadAllAndIndex(id);
  const now = new Date().toISOString();
  all[idx] = { ...all[idx], deleted: true, deletedAt: now, updatedAt: now };
  await saveAll(all);
  return { ok: true };
}

export async function setProjectAnalysis(id, analysis) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = setAudioAnalysis(all[idx], analysis);
  await saveAll(all);
  return all[idx];
}

export async function addProjectScene(id, sceneInput) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, scene } = addScene(all[idx], sceneInput);
  all[idx] = project;
  await saveAll(all);
  return scene;
}

export async function updateScene(id, sceneId, patch) {
  const { all, idx } = await loadAllAndIndex(id);
  const { project, updated } = applySceneUpdate(all[idx], sceneId, patch);
  all[idx] = project;
  await saveAll(all);
  return updated;
}

export async function deleteScene(id, sceneId) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = removeScene(all[idx], sceneId);
  await saveAll(all);
  return all[idx];
}

export async function reorderProjectScenes(id, orderedIds) {
  const { all, idx } = await loadAllAndIndex(id);
  all[idx] = reorderScenes(all[idx], orderedIds);
  await saveAll(all);
  return all[idx];
}
