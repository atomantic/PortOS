/** Production persistence is data-only; later stages own contained execution. */
import { randomUUID } from 'crypto';
import { codeAnimationPackageSchema, summarizeCodeAnimationPackage } from '../../lib/codeAnimationPackage.js';
import { codeAnimationProjectSchema, codeAnimationProjectPatchSchema } from '../../lib/codeAnimationProjects.js';
import { validateRequest } from '../../lib/validation.js';
import { ServerError } from '../../lib/errorHandler.js';
import { emitCodeAnimationChanged } from '../socket.js';
import * as store from './projectStore.js';
import { stageProjectFiles, readProjectFiles, sourceHashOf } from './projectFiles.js';
import { activeStageRunIds } from './stages.js';

const activeImports = new Set();

export async function getProductionProject(id) {
  const project = await store.getProjectRecord(id);
  if (!project) throw new ServerError('Production project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

export async function createProductionProject(input) {
  const project = await store.createProjectRecord(randomUUID(), validateRequest(codeAnimationProjectSchema, input));
  emitCodeAnimationChanged(project.id);
  return project;
}

export async function patchProductionProject(id, input) {
  const project = await store.patchProjectRecord(id, validateRequest(codeAnimationProjectPatchSchema, input));
  emitCodeAnimationChanged(id);
  return project;
}

export const listProductionProjects = page => store.pageProjectRecords(page);
export async function getProductionHistory(id, page) {
  await getProductionProject(id);
  await store.interruptImports(id, [...activeImports]);
  await store.interruptStageRuns(id, activeStageRunIds());
  return store.pageProjectHistory(id, page);
}

export async function importProductionPackage(projectId, input) {
  const pkg = validateRequest(codeAnimationPackageSchema, input);
  await getProductionProject(projectId);
  const runId = randomUUID();
  const revisionId = randomUUID();
  const totalBytes = summarizeCodeAnimationPackage(pkg).totalBytes;
  let staged = false;
  activeImports.add(runId);
  try {
    const allowed = await store.startImportRecord(runId, projectId, {
      kind: 'package-import', packageHash: pkg.revisionHash, executed: false,
      effective: null, stageRunIds: {}, totalBytes, ownedRevisionId: revisionId,
      relativePath: `code-animations/projects/${projectId}/revisions/${revisionId}`,
    });
    if (!allowed) {
      throw new ServerError('Package exceeds the project disk budget', { status: 409, code: 'CODE_ANIMATION_DISK_BUDGET' });
    }
    const storage = await stageProjectFiles(projectId, revisionId, pkg.files);
    staged = true;
    const revision = {
      id: revisionId, packageHash: pkg.revisionHash,
      sourceHash: sourceHashOf(pkg.files),
      totalBytes, schemaVersion: pkg.schemaVersion, manifest: pkg.manifest,
      files: pkg.files.map(({ content: _content, ...file }) => file),
      storage, createdAt: new Date().toISOString(),
    };
    const saved = await store.commitImportRecord(projectId, revision, runId);
    emitCodeAnimationChanged(projectId);
    return { project: saved, revision, runId, executed: false };
  } catch (error) {
    // Keep accepted work and the failed run. A staged orphan is retained on DB
    // failure, never mistaken for an accepted revision or automatically run.
    await store.failImportRecord(runId, error.code || 'IMPORT_FAILED', !staged);
    emitCodeAnimationChanged(projectId);
    throw error;
  } finally {
    activeImports.delete(runId);
  }
}

export async function acceptProductionSource(projectId, revisionId) {
  const revision = await store.getRevisionRecord(projectId, revisionId);
  if (!revision) throw new ServerError('Revision not found', { status: 404, code: 'NOT_FOUND' });
  await readProjectFiles(projectId, revisionId, revision.files);
  const project = await store.acceptProjectRevision(projectId, revisionId);
  emitCodeAnimationChanged(projectId);
  return project;
}

export async function exportProductionPackage(projectId, revisionId) {
  const revision = await store.getRevisionRecord(projectId, revisionId);
  if (!revision) throw new ServerError('Revision not found', { status: 404, code: 'NOT_FOUND' });
  return validateRequest(codeAnimationPackageSchema, {
    schemaVersion: revision.schemaVersion, manifest: revision.manifest,
    files: await readProjectFiles(projectId, revisionId, revision.files),
    revisionHash: revision.packageHash,
  });
}

export async function exportProductionBrief(id) {
  const { manifest, budgets } = await getProductionProject(id);
  // Instance provider/connection ids, reference ids and managed paths stay local.
  return { schemaVersion: 1, manifest: { ...manifest, execution: { requested: null, effective: null } }, budgets };
}
