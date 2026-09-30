/**
 * Music Video — development artifact workflow: import/upload, generated saves,
 * notes, review and soft delete over the pure transforms in devArtifacts.js
 * and the file store in devArtifactStore.js.
 *
 * Every record write goes through `mutateProjectRecord`, so it runs against the
 * freshest project under the backend's write serialization. A file is written
 * BEFORE its record update (a version number is reserved by reading the record
 * first); when the update is refused the file is removed again, so a failed
 * import leaves nothing behind.
 */

import { extname } from 'path';
import { unlink } from 'fs/promises';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { musicVideoEvents } from './events.js';
import {
  addDevArtifactNote,
  addDevArtifactVersion,
  deleteDevArtifact,
  devArtifactTypeFor,
  devArtifactVersion,
  findDevArtifact,
  liveDevArtifacts,
  newDevArtifactId,
  nextDevArtifactVersion,
  resolveDevArtifactNote,
  reviewDevArtifact,
} from './devArtifacts.js';
import { discardDevArtifactFile, resolveDevArtifactFile, writeDevArtifactFile } from './devArtifactStore.js';

async function requireProject(id) {
  const project = await getProject(id);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  return project;
}

function publish(projectId, project, artifact) {
  musicVideoEvents.emit('dev-artifact', { projectId, artifactId: artifact?.id || null, project });
}

/** Live artifacts, newest activity first. */
export async function listDevArtifacts(projectId) {
  return liveDevArtifacts(await requireProject(projectId));
}

/** One live artifact. */
export async function getDevArtifact(projectId, artifactId) {
  return findDevArtifact(await requireProject(projectId), artifactId);
}

/**
 * Store a file (upload or generated) as a new artifact, or as the next version
 * of `artifactId`. `ext` picks the served media type. Returns `{ project, artifact }`.
 */
async function storeVersion(projectId, {
  artifactId = null, kind, title, ext, buffer = null, tempPath = null, source, status = null, notes = [],
}) {
  const mimeType = devArtifactTypeFor(ext);
  if (!mimeType) throw new ServerError('Unsupported file type — accepted: HTML, Markdown, MP4, PNG, JPG', { status: 400, code: 'VALIDATION_ERROR' });
  const project = await requireProject(projectId);
  if (artifactId) findDevArtifact(project, artifactId);
  const id = artifactId || newDevArtifactId();
  const version = nextDevArtifactVersion(project, artifactId);
  const { file, bytes } = await writeDevArtifactFile({
    projectId, artifactId: id, version, ext: ext === 'jpeg' ? 'jpg' : ext, buffer, tempPath,
  });
  const out = await mutateProjectRecord(projectId, (current) => {
    // A concurrent write took this version number: refuse rather than point
    // two versions at one file.
    if (nextDevArtifactVersion(current, artifactId) !== version) {
      throw new ServerError('Another version of this artifact was saved at the same time — try again', { status: 409, code: 'DEV_ARTIFACT_CONFLICT' });
    }
    return addDevArtifactVersion(current, {
      artifactId, id: artifactId ? null : id, kind, title, file, mimeType, bytes, source, status, notes,
    });
  }).catch(async (err) => {
    await discardDevArtifactFile(file);
    throw err;
  });
  console.log(`🗂️ Music Video dev artifact ${out.artifact.id.slice(4, 12)} v${version} saved for ${projectId.slice(0, 11)} (${out.artifact.kind}, ${mimeType})`);
  publish(projectId, out.project, out.artifact);
  return { project: out.project, artifact: out.artifact };
}

/**
 * Import an uploaded file. The temp upload is always removed. `notes` are
 * plain strings (or `{ text, target }`) recorded against the new version.
 */
export async function importDevArtifact(projectId, { tempPath, originalName, artifactId = null, kind, title, status = null, notes = [] }) {
  try {
    const ext = extname(String(originalName || '')).slice(1).toLowerCase();
    return await storeVersion(projectId, {
      artifactId,
      kind,
      title: title || String(originalName || '').replace(/\.[^.]+$/, ''),
      ext,
      tempPath,
      source: 'upload',
      status,
      notes: notes.map((n) => (typeof n === 'string' ? { text: n } : n)),
    });
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}

/** Save generated HTML (e.g. the Cast & Sets sheet) as a new artifact or version. */
export async function saveGeneratedDevArtifact(projectId, { artifactId = null, kind, title, html, status = null, source = 'generated' }) {
  return storeVersion(projectId, {
    artifactId, kind, title, ext: 'html', buffer: Buffer.from(html, 'utf8'), source, status,
  });
}

/**
 * Resolve the file to serve for a version (`version` null = current).
 * Returns `{ path, mimeType, artifact, version }`.
 */
export async function resolveDevArtifactDownload(projectId, artifactId, version = null) {
  const artifact = await getDevArtifact(projectId, artifactId);
  const entry = devArtifactVersion(artifact, version);
  const path = resolveDevArtifactFile(entry.file);
  if (!path) throw new ServerError('Artifact file path is invalid', { status: 404, code: 'NOT_FOUND' });
  return { path, mimeType: entry.mimeType, artifact, version: entry.version };
}

export async function addNote(projectId, artifactId, input) {
  const out = await mutateProjectRecord(projectId, (current) => addDevArtifactNote(current, artifactId, input));
  publish(projectId, out.project, out.artifact);
  return { project: out.project, artifact: out.artifact, note: out.note };
}

export async function setNoteResolved(projectId, artifactId, noteId, resolved) {
  const out = await mutateProjectRecord(projectId, (current) => resolveDevArtifactNote(current, artifactId, noteId, resolved));
  publish(projectId, out.project, out.artifact);
  return { project: out.project, artifact: out.artifact, note: out.note };
}

/**
 * Approve / request changes. Approving the sheet the Cast & Sets stage is
 * waiting on is the stage's own "Approve & continue", so it is delegated there
 * (the stage then applies its references and releases the autopilot).
 */
export async function reviewArtifact(projectId, artifactId, { status, note = null }) {
  const project = await requireProject(projectId);
  findDevArtifact(project, artifactId);
  const stage = project.castAndSets;
  if (status === 'approved' && stage?.artifactId === artifactId && stage.status === 'review') {
    const { approveCastAndSets } = await import('./castAndSetsService.js');
    if (note) await addNote(projectId, artifactId, { text: note });
    const approved = await approveCastAndSets(projectId);
    return { project: approved.project, artifact: findDevArtifact(approved.project, artifactId) };
  }
  const out = await mutateProjectRecord(projectId, (current) => reviewDevArtifact(current, artifactId, { status, note }));
  console.log(`🗂️ Music Video dev artifact ${artifactId.slice(4, 12)} marked ${status}`);
  publish(projectId, out.project, out.artifact);
  return { project: out.project, artifact: out.artifact };
}

export async function removeDevArtifact(projectId, artifactId) {
  const out = await mutateProjectRecord(projectId, (current) => deleteDevArtifact(current, artifactId));
  publish(projectId, out.project, null);
  return { project: out.project };
}
