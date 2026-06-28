/**
 * Music Video — project store backend dispatcher (#1760, Phase 1).
 *
 * Mirrors the Creative Director dispatcher (services/creativeDirector/local.js):
 * a thin layer that picks the backend so every import site + test mock targets
 * one module.
 *
 * Backend selection (same posture as the memory backend):
 *   - PostgreSQL (projectsDB.js) for normal installs.
 *   - File (projectsFile.js) only via MEMORY_BACKEND=file (escape hatch) or
 *     NODE_ENV=test — both UNSUPPORTED for production. Tests boot without a DB,
 *     so they exercise the file backend.
 *
 * Federation note: peer-sync of `musicVideoProject` records (record-event emit,
 * LWW merge, tombstone GC — the wiring the CD store carries) is a deliberate
 * follow-up, tracked as its own issue. The store is db-primary and fully usable
 * locally now; adding federation later is additive (the soft-delete fields are
 * already on the record). Until then this dispatcher does no record-event emit.
 */

import { checkHealth, ensureSchema } from '../../lib/db.js';

let backend = null;
let backendName = null;

async function selectBackend() {
  if (backend) return backend;

  const envBackend = process.env.MEMORY_BACKEND;
  if (envBackend === 'file' || process.env.NODE_ENV === 'test') {
    backend = await import('./projectsFile.js');
    backendName = 'file';
    return backend;
  }

  // Default + explicit postgres → PostgreSQL. ensureSchema() is idempotent and
  // run here (mirroring memoryBackend.js) so the backend is self-sufficient
  // regardless of boot ordering.
  const health = await checkHealth();
  if (!health.connected) {
    throw new Error('Music Video requires PostgreSQL — run `npm run setup:db` (dev/test only: set PGMODE=file in .env)');
  }
  await ensureSchema();
  backend = await import('./projectsDB.js');
  backendName = 'postgres';
  return backend;
}

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getProjectsBackendName() {
  return backendName;
}

export async function listProjects(options = {}) {
  return (await selectBackend()).listProjects(options);
}

export async function getProject(id, options = {}) {
  return (await selectBackend()).getProject(id, options);
}

export async function createProject(input) {
  return (await selectBackend()).createProject(input);
}

export async function updateProject(id, patch) {
  return (await selectBackend()).updateProject(id, patch);
}

export async function deleteProject(id) {
  return (await selectBackend()).deleteProject(id);
}

export async function setProjectAnalysis(id, analysis) {
  return (await selectBackend()).setProjectAnalysis(id, analysis);
}

export async function addProjectScene(id, sceneInput) {
  return (await selectBackend()).addProjectScene(id, sceneInput);
}

export async function updateScene(id, sceneId, patch) {
  return (await selectBackend()).updateScene(id, sceneId, patch);
}

export async function deleteScene(id, sceneId) {
  return (await selectBackend()).deleteScene(id, sceneId);
}

export async function reorderProjectScenes(id, orderedIds) {
  return (await selectBackend()).reorderProjectScenes(id, orderedIds);
}
