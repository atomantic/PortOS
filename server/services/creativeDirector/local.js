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
import { emitRecordUpdated, emitRecordDeleted, autoSubscribeRecordToAllPeers } from '../sharing/recordEvents.js';

export { trimRuns, startingImageFilename } from './projectsLogic.js';

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

// Announce a newly-created project to the per-record peer-sync pipeline (#1564):
// emit the 'updated' event so any existing subscription pushes it, AND
// auto-subscribe every creativeDirectorProjects-enabled peer so brand-new
// projects (and their later tombstones) propagate. Routed through the
// recordEvents subscription adapter (a no-op until peerSync registers it at
// boot) so this store doesn't import peerSync — peerSync statically imports
// mergeProjectsFromSync from here, so importing it back would close a load-order
// cycle. Mirrors authors/index.js announceNewAuthor.
function announceNewProject(id) {
  emitRecordUpdated('creativeDirectorProject', id);
  autoSubscribeRecordToAllPeers('creativeDirectorProject', id).catch(() => {});
}

export async function listProjects(options = {}) {
  return (await selectBackend()).listProjects(options);
}

export async function getProject(id, options = {}) {
  return (await selectBackend()).getProject(id, options);
}

/** Live project ids (or all when includeDeleted) — used by tombstone GC sweeps. */
export async function listProjectIds(options = {}) {
  return (await selectBackend()).listProjectIds(options);
}

export async function createProject(input) {
  const project = await (await selectBackend()).createProject(input);
  announceNewProject(project.id);
  return project;
}

export async function updateProject(id, patch) {
  const next = await (await selectBackend()).updateProject(id, patch);
  // A standalone project reaches peers only via its per-record subscription —
  // without this emit a structural edit never propagates after the initial
  // subscribe. The hot-path render mutators (recordRun/updateRun) deliberately
  // do NOT emit (they fire many times per scene render); run-history converges
  // on the next structural push, which carries the whole record (runs included).
  emitRecordUpdated('creativeDirectorProject', next.id);
  return next;
}

export async function deleteProject(id) {
  const result = await (await selectBackend()).deleteProject(id);
  // Soft-delete tombstone — push the deletion to subscribed peers immediately.
  emitRecordDeleted('creativeDirectorProject', id);
  return result;
}

export async function setTreatment(id, treatmentInput) {
  const next = await (await selectBackend()).setTreatment(id, treatmentInput);
  emitRecordUpdated('creativeDirectorProject', id);
  return next;
}

export async function updateScene(id, sceneId, patch) {
  const result = await (await selectBackend()).updateScene(id, sceneId, patch);
  emitRecordUpdated('creativeDirectorProject', id);
  return result;
}

/** Merge an incoming batch of project records from a peer (LWW, tombstone-aware). */
export async function mergeProjectsFromSync(remoteProjects, options = {}) {
  return (await selectBackend()).mergeProjectsFromSync(remoteProjects, options);
}

/** Hard-remove project tombstones older than the cutoff (called by tombstone GC). */
export async function pruneTombstonedProjects(olderThanMs) {
  return (await selectBackend()).pruneTombstonedProjects(olderThanMs);
}

export async function recordRun(id, runEntry) {
  return (await selectBackend()).recordRun(id, runEntry);
}

export async function updateRun(id, runId, patch) {
  return (await selectBackend()).updateRun(id, runId, patch);
}
