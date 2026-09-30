/**
 * Music Video — development artifacts ("ingredients"): pure record transforms.
 *
 * A project carries a list of reviewable development files — a Cast & Sets
 * check-in sheet, an animatic, a treatment, a storyboard — each with its own
 * review status, notes and version history. The BYTES of every version are an
 * immutable file under `data/music-video/<projectId>/dev/<artifactId>/v<N>.<ext>`
 * (devArtifactStore.js); only the metadata below lives on the project record:
 *
 *   {
 *     id, kind, title, status, version, file, mimeType, bytes,
 *     createdAt, updatedAt, deleted, deletedAt,
 *     versions: [{ version, file, mimeType, bytes, source, createdAt }],
 *     notes:    [{ id, text, target, version, createdAt, resolvedAt }],
 *   }
 *
 * `version`/`file`/`mimeType`/`bytes` mirror the newest entry of `versions`, so
 * a reader that only wants "the current sheet" never walks the history. A new
 * version resets the review to `pending` unless the writer names a status
 * (the Cast & Sets stage approves its own sheet in auto mode). Deletion is a
 * soft tombstone; files are never unlinked, so an old version stays viewable
 * from a clone that still points at it.
 *
 * Peer sync: `devArtifacts` is WIRE-LOCAL (lib/syncWire.js), like
 * `productionRuns` — the files it points at exist only on this install (the
 * project's asset manifest does not ship them), so a peer would receive
 * dangling pointers. `mergeProjectRecord` restores the local list over a newer
 * remote copy.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { trimTo } from '../../lib/textUtils.js';
import { MUSIC_VIDEO_DEV_ARTIFACT_KINDS, MUSIC_VIDEO_DEV_ARTIFACT_STATUSES } from '../../lib/musicVideoValidation.js';

const DEV_ARTIFACT_KINDS = MUSIC_VIDEO_DEV_ARTIFACT_KINDS;
const DEV_ARTIFACT_STATUSES = MUSIC_VIDEO_DEV_ARTIFACT_STATUSES;
// Extension → served media type. The only formats a development file may be.
export const DEV_ARTIFACT_TYPES = Object.freeze({
  html: 'text/html',
  md: 'text/markdown',
  mp4: 'video/mp4',
  png: 'image/png',
  jpg: 'image/jpeg',
});
export const DEV_ARTIFACT_TITLE_MAX = 200;
export const DEV_ARTIFACT_NOTE_MAX = 2000;
export const DEV_ARTIFACT_TARGET_MAX = 120;
const MAX_ARTIFACTS = 100;
const MAX_VERSIONS = 100;
const MAX_NOTES = 500;

const artifactError = (status, code, message) => new ServerError(message, { status, code });

/** Every artifact on a project (tombstones included), tolerating a record with none. */
export const projectDevArtifacts = (project) => (Array.isArray(project?.devArtifacts) ? project.devArtifacts : []);

/** Live (not deleted) artifacts, newest activity first. */
export const liveDevArtifacts = (project) => projectDevArtifacts(project)
  .filter((a) => !a?.deleted)
  .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

/** One live artifact, or a 404. */
export function findDevArtifact(project, artifactId) {
  const artifact = projectDevArtifacts(project).find((a) => a?.id === artifactId && !a.deleted);
  if (!artifact) throw artifactError(404, 'NOT_FOUND', 'Development artifact not found');
  return artifact;
}

/** The media type for a filename extension, or null when the format is not accepted. */
export function devArtifactTypeFor(ext) {
  const key = String(ext || '').toLowerCase().replace(/^\./, '');
  return DEV_ARTIFACT_TYPES[key === 'jpeg' ? 'jpg' : key] || null;
}

/** A fresh artifact id (also the per-artifact folder name on disk). */
export const newDevArtifactId = () => `mvd-${randomUUID()}`;

/** The version number the NEXT file of this artifact will carry (1 for a new artifact). */
export const nextDevArtifactVersion = (project, artifactId) => {
  const existing = artifactId ? projectDevArtifacts(project).find((a) => a?.id === artifactId) : null;
  return (existing?.versions || []).reduce((max, v) => Math.max(max, v.version || 0), 0) + 1;
};

function buildNote(input, version, now) {
  const text = trimTo(input?.text, DEV_ARTIFACT_NOTE_MAX);
  if (!text) throw artifactError(422, 'VALIDATION_ERROR', 'A note needs text');
  const target = trimTo(input?.target, DEV_ARTIFACT_TARGET_MAX);
  return {
    id: `mvdn-${randomUUID()}`,
    text,
    target: target || null,
    version,
    createdAt: now,
    resolvedAt: input?.resolved ? now : null,
  };
}

function replaceArtifact(project, next, now) {
  return {
    ...project,
    devArtifacts: projectDevArtifacts(project).map((a) => (a?.id === next.id ? next : a)),
    updatedAt: now,
  };
}

/**
 * Record a new file version. `artifactId` null creates a new artifact (then
 * `kind` and `title` are required); an id adds a version to that artifact.
 * `file` is the data-relative path the store already wrote. Returns
 * `{ project, artifact }`.
 */
export function addDevArtifactVersion(project, {
  artifactId = null, id = null, kind, title, file, mimeType, bytes = null, source = 'upload',
  status = null, notes = [],
}, now = new Date().toISOString()) {
  if (status != null && !DEV_ARTIFACT_STATUSES.includes(status)) throw artifactError(422, 'VALIDATION_ERROR', `Unknown status ${status}`);
  const existing = artifactId ? findDevArtifact(project, artifactId) : null;
  const version = nextDevArtifactVersion(project, existing?.id);
  const entry = {
    version, file, mimeType, bytes: Number.isFinite(bytes) ? bytes : null, source: trimTo(source, 40) || 'upload', createdAt: now,
  };
  if (existing) {
    if ((existing.versions || []).length >= MAX_VERSIONS) throw artifactError(409, 'DEV_ARTIFACT_VERSION_LIMIT', `An artifact keeps at most ${MAX_VERSIONS} versions`);
    const next = {
      ...existing,
      ...(title ? { title: trimTo(title, DEV_ARTIFACT_TITLE_MAX) } : {}),
      version,
      file,
      mimeType,
      bytes: entry.bytes,
      status: status || 'pending',
      versions: [...(existing.versions || []), entry],
      notes: [...(existing.notes || []), ...notes.map((n) => buildNote(n, version, now))].slice(-MAX_NOTES),
      updatedAt: now,
    };
    return { project: replaceArtifact(project, next, now), artifact: next };
  }
  if (!DEV_ARTIFACT_KINDS.includes(kind)) throw artifactError(422, 'VALIDATION_ERROR', `Unknown artifact kind ${kind}`);
  const cleanTitle = trimTo(title, DEV_ARTIFACT_TITLE_MAX);
  if (!cleanTitle) throw artifactError(422, 'VALIDATION_ERROR', 'An artifact needs a title');
  if (liveDevArtifacts(project).length >= MAX_ARTIFACTS) throw artifactError(409, 'DEV_ARTIFACT_LIMIT', `A project keeps at most ${MAX_ARTIFACTS} development artifacts`);
  const artifact = {
    id: id || newDevArtifactId(),
    kind,
    title: cleanTitle,
    status: status || 'pending',
    version,
    file,
    mimeType,
    bytes: entry.bytes,
    versions: [entry],
    notes: notes.map((n) => buildNote(n, version, now)).slice(-MAX_NOTES),
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  };
  return {
    project: { ...project, devArtifacts: [...projectDevArtifacts(project), artifact], updatedAt: now },
    artifact,
  };
}

/** Add a review note (against the artifact's current version). Returns `{ project, artifact, note }`. */
export function addDevArtifactNote(project, artifactId, input, now = new Date().toISOString()) {
  const artifact = findDevArtifact(project, artifactId);
  if ((artifact.notes || []).length >= MAX_NOTES) throw artifactError(409, 'DEV_ARTIFACT_NOTE_LIMIT', `An artifact keeps at most ${MAX_NOTES} notes`);
  const note = buildNote(input, artifact.version, now);
  const next = { ...artifact, notes: [...(artifact.notes || []), note], updatedAt: now };
  return { project: replaceArtifact(project, next, now), artifact: next, note };
}

/** Mark a note resolved (or open again). Returns `{ project, artifact, note }`. */
export function resolveDevArtifactNote(project, artifactId, noteId, resolved, now = new Date().toISOString()) {
  const artifact = findDevArtifact(project, artifactId);
  const current = (artifact.notes || []).find((n) => n.id === noteId);
  if (!current) throw artifactError(404, 'NOT_FOUND', 'Note not found');
  const note = { ...current, resolvedAt: resolved ? (current.resolvedAt || now) : null };
  const next = { ...artifact, notes: artifact.notes.map((n) => (n.id === noteId ? note : n)), updatedAt: now };
  return { project: replaceArtifact(project, next, now), artifact: next, note };
}

/** Resolve every open note matching `predicate` in one write (a regeneration consumed them). */
export function resolveDevArtifactNotes(project, artifactId, predicate = () => true, now = new Date().toISOString()) {
  const artifact = findDevArtifact(project, artifactId);
  const notes = (artifact.notes || []).map((n) => (!n.resolvedAt && predicate(n) ? { ...n, resolvedAt: now } : n));
  const next = { ...artifact, notes, updatedAt: now };
  return { project: replaceArtifact(project, next, now), artifact: next };
}

/**
 * Set the review status. A request for changes may carry the note that says
 * what to change. Returns `{ project, artifact }`.
 */
export function reviewDevArtifact(project, artifactId, { status, note = null }, now = new Date().toISOString()) {
  if (!DEV_ARTIFACT_STATUSES.includes(status)) throw artifactError(422, 'VALIDATION_ERROR', `Unknown status ${status}`);
  const artifact = findDevArtifact(project, artifactId);
  const added = note && trimTo(note, DEV_ARTIFACT_NOTE_MAX) ? [buildNote({ text: note }, artifact.version, now)] : [];
  const next = { ...artifact, status, notes: [...(artifact.notes || []), ...added], updatedAt: now };
  return { project: replaceArtifact(project, next, now), artifact: next };
}

/** Soft-delete an artifact (its files stay on disk). Returns `{ project, artifact }`. */
export function deleteDevArtifact(project, artifactId, now = new Date().toISOString()) {
  const artifact = findDevArtifact(project, artifactId);
  const next = { ...artifact, deleted: true, deletedAt: now, updatedAt: now };
  return { project: replaceArtifact(project, next, now), artifact: next };
}

/** The version entry to serve: `version` null = the current one. */
export function devArtifactVersion(artifact, version = null) {
  const versions = artifact?.versions || [];
  const found = version == null
    ? versions.find((v) => v.version === artifact.version) || versions[versions.length - 1]
    : versions.find((v) => v.version === version);
  if (!found) throw artifactError(404, 'NOT_FOUND', 'Artifact version not found');
  return found;
}
