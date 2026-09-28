/**
 * Music Video — draft excerpt record transforms (#8986, part of #8966).
 *
 * A project may carry a list of `excerpts`: a director-chosen `[startSec, endSec)`
 * window re-rendered at full quality through the same composed pipeline as a
 * full render (see `render.js` `buildMusicVideoFfmpegArgs`'s `excerpt` option),
 * plus a contact sheet sampled at the range's cut and cue boundaries and a set
 * of timecoded review notes. Frame checks alone can't validate motion/audio
 * sync, so the note timeline is the excerpt's OWN (0 = the excerpt's start) —
 * the UI plays the excerpt alongside the sheet and lets the director drop a
 * note at whatever moment they're watching.
 *
 * Peer sync: `excerpts` is an additive field on the whole-record LWW project
 * body (same posture as `treatment`/`scene.direction`, #8980). An older peer
 * stores it verbatim, carries it through its own edits (every mutator spreads
 * the record), and never executes it (it has no excerpt render route to run
 * against a project it receives), so no `musicVideoProjects` schema bump is
 * needed.
 *
 * Every transform here is pure (project in, project out) so the I/O layer
 * (`excerptService.js`, `excerptRender.js`) can run it under
 * `mutateProjectRecord`'s write serialization without duplicating validation.
 */

import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { isNonBlankStr, trimTo } from '../../lib/textUtils.js';

const MAX_NOTE_LEN = 2000;
const MAX_EXCERPT_SEC = 3600;

function excerptError(status, code, message, context) {
  return new ServerError(message, { status, code, ...(context ? { context } : {}) });
}

/** The excerpt array on a project, tolerating a legacy record with none. */
export const projectExcerpts = (project) => (Array.isArray(project?.excerpts) ? project.excerpts : []);

/** Find one excerpt by id, or throw 404. */
function findExcerpt(project, excerptId) {
  const excerpt = projectExcerpts(project).find((e) => e.id === excerptId);
  if (!excerpt) throw excerptError(404, 'NOT_FOUND', 'Excerpt not found');
  return excerpt;
}

/**
 * Add a new `status: 'rendering'` excerpt record to the project. Its `id`
 * doubles as the render job id (one render at a time per excerpt) — the
 * caller kicks off the ffmpeg job under that same id. Returns the updated
 * project; the render job fills in `filename`/`contactSheetFilename` (or
 * `error`) once the encode finishes.
 */
export function startExcerptOnProject(project, { startSec, endSec }, now = new Date().toISOString()) {
  if (!(startSec >= 0) || !(endSec > startSec) || endSec > MAX_EXCERPT_SEC) {
    throw excerptError(422, 'INVALID_EXCERPT_RANGE', 'endSec must be greater than startSec, and both within range');
  }
  const id = `mve-${randomUUID()}`;
  const excerpt = {
    id,
    startSec,
    endSec,
    status: 'rendering',
    jobId: id,
    filename: null,
    contactSheetFilename: null,
    error: null,
    notes: [],
    createdAt: now,
    updatedAt: now,
  };
  return { project: { ...project, excerpts: [...projectExcerpts(project), excerpt] }, excerpt };
}

/** Merge a patch (status/filename/contactSheetFilename/error/jobId) onto one excerpt. */
export function applyExcerptPatch(project, excerptId, patch, now = new Date().toISOString()) {
  findExcerpt(project, excerptId); // 404 if missing
  return {
    ...project,
    excerpts: projectExcerpts(project).map((e) => (e.id === excerptId ? { ...e, ...patch, updatedAt: now } : e)),
  };
}

/**
 * Drop one excerpt record. Throws 404 if it doesn't exist, or 409 while its
 * render is still in flight (the caller cancels that job first). Returns
 * `{ project, excerpt }` — the removed excerpt, so the caller can clean up its
 * on-disk video/contact-sheet files.
 */
export function removeExcerptFromProject(project, excerptId) {
  const excerpt = findExcerpt(project, excerptId); // 404 if missing
  if (excerpt.status === 'rendering') {
    throw excerptError(409, 'EXCERPT_RENDERING', 'Cancel the in-progress render before deleting this excerpt');
  }
  return { project: { ...project, excerpts: projectExcerpts(project).filter((e) => e.id !== excerptId) }, excerpt };
}

const clampAtSec = (atSec, excerpt) => {
  if (typeof atSec !== 'number' || !Number.isFinite(atSec) || atSec < 0) {
    throw excerptError(422, 'VALIDATION_ERROR', 'atSec must be a non-negative number');
  }
  const span = excerpt.endSec - excerpt.startSec;
  // A small tolerance past the last frame — the player's own duration and the
  // encoded file's can differ by a fraction of a frame.
  if (atSec > span + 0.25) {
    throw excerptError(422, 'VALIDATION_ERROR', `atSec must fall within the excerpt's own ${span.toFixed(2)}s duration`);
  }
  return Math.min(atSec, span);
};

/** Append a timecoded review note (0 = the excerpt's own start). */
export function addExcerptNote(project, excerptId, { atSec, note, verdict = null }, now = new Date().toISOString()) {
  const excerpt = findExcerpt(project, excerptId);
  if (!isNonBlankStr(note)) throw excerptError(422, 'VALIDATION_ERROR', 'A review note needs text');
  const record = { id: `mvn-${randomUUID()}`, atSec: clampAtSec(atSec, excerpt), note: trimTo(note, MAX_NOTE_LEN), verdict: verdict ?? null, createdAt: now, updatedAt: now };
  const next = { ...excerpt, notes: [...excerpt.notes, record], updatedAt: now };
  return { project: { ...project, excerpts: projectExcerpts(project).map((e) => (e.id === excerptId ? next : e)) }, note: record };
}

function findNote(excerpt, noteId) {
  const note = (excerpt.notes || []).find((n) => n.id === noteId);
  if (!note) throw excerptError(404, 'NOT_FOUND', 'Review note not found');
  return note;
}

/** Edit a review note's text, timecode, and/or verdict. */
export function updateExcerptNote(project, excerptId, noteId, patch, now = new Date().toISOString()) {
  const excerpt = findExcerpt(project, excerptId);
  const existing = findNote(excerpt, noteId);
  const next = { ...existing, updatedAt: now };
  if (patch.atSec !== undefined) next.atSec = clampAtSec(patch.atSec, excerpt);
  if (patch.note !== undefined) {
    if (!isNonBlankStr(patch.note)) throw excerptError(422, 'VALIDATION_ERROR', 'A review note needs text');
    next.note = trimTo(patch.note, MAX_NOTE_LEN);
  }
  if (patch.verdict !== undefined) next.verdict = patch.verdict;
  const nextExcerpt = { ...excerpt, notes: excerpt.notes.map((n) => (n.id === noteId ? next : n)), updatedAt: now };
  return { project: { ...project, excerpts: projectExcerpts(project).map((e) => (e.id === excerptId ? nextExcerpt : e)) }, note: next };
}

/** Remove a review note. */
export function removeExcerptNote(project, excerptId, noteId) {
  const excerpt = findExcerpt(project, excerptId);
  findNote(excerpt, noteId); // 404 if missing
  const nextExcerpt = { ...excerpt, notes: excerpt.notes.filter((n) => n.id !== noteId) };
  return { ...project, excerpts: projectExcerpts(project).map((e) => (e.id === excerptId ? nextExcerpt : e)) };
}
