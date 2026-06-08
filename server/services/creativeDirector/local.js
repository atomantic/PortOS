/**
 * Creative Director — project state CRUD (backend dispatcher).
 *
 * Historically this module was the file-backed store directly. As of Phase 3
 * (#997) Creative Director projects live in PostgreSQL (creative_director_projects),
 * and this module became a thin dispatcher — mirroring memoryBackend.js — so
 * the 8 import sites and every test mock that targets `./local.js` keep working
 * unchanged.
 *
 * Backend selection (same posture as the memory backend):
 *   - PostgreSQL (projectsDB.js) for normal installs.
 *   - File (projectsFile.js) only via MEMORY_BACKEND=file (escape hatch) or
 *     NODE_ENV=test — both UNSUPPORTED for production. Tests boot without a DB,
 *     so they exercise the file backend and need no Postgres.
 *
 * The first PG init runs a one-time, marker-gated import of any legacy
 * data/creative-director-projects.json rows into the table (see
 * scripts/migrateCreativeDirectorToDB.js), so the boot recovery scan — the first
 * caller — sees migrated projects.
 *
 * `trimRuns` is re-exported from projectsLogic.js for the migration + any caller
 * that imported it from here historically.
 */

import { checkHealth, ensureSchema } from '../../lib/db.js';

export { trimRuns } from './projectsLogic.js';

let backend = null;
let backendName = null;

async function selectBackend() {
  if (backend) return backend;

  const envBackend = process.env.MEMORY_BACKEND;

  // Explicit file escape hatch, or test mode (no DB) → file backend.
  if (envBackend === 'file' || process.env.NODE_ENV === 'test') {
    backend = await import('./projectsFile.js');
    backendName = 'file';
    return backend;
  }

  // Default + explicit postgres → PostgreSQL. The boot DB gate in
  // server/index.js fail-fasts when Postgres is required but missing, but the
  // boot RECOVERY scan (recoverInFlightProjects) calls in here BEFORE that gate
  // runs ensureSchema() — so an upgrade install may not have the
  // creative_director_projects table yet at first call. Mirror memoryBackend.js
  // and run ensureSchema() here ourselves (idempotent) so the backend is
  // self-sufficient regardless of boot ordering.
  const health = await checkHealth();
  if (!health.connected) {
    throw new Error('Creative Director requires PostgreSQL — run `npm run setup:db` (dev/test only: set PGMODE=file in .env; the launcher maps it to MEMORY_BACKEND=file for the unsupported file backend)');
  }
  await ensureSchema();
  const { migrateCreativeDirectorToDB } = await import('../../scripts/migrateCreativeDirectorToDB.js');
  await migrateCreativeDirectorToDB();
  backend = await import('./projectsDB.js');
  backendName = 'postgres';
  return backend;
}

/** Name of the active backend, or null before first call (for diagnostics/tests). */
export function getProjectsBackendName() {
  return backendName;
}

export async function listProjects() {
  return (await selectBackend()).listProjects();
}

export async function getProject(id) {
  return (await selectBackend()).getProject(id);
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

export async function setTreatment(id, treatmentInput) {
  return (await selectBackend()).setTreatment(id, treatmentInput);
}

export async function updateScene(id, sceneId, patch) {
  return (await selectBackend()).updateScene(id, sceneId, patch);
}

export async function recordRun(id, runEntry) {
  return (await selectBackend()).recordRun(id, runEntry);
}

export async function updateRun(id, runId, patch) {
  return (await selectBackend()).updateRun(id, runId, patch);
}
