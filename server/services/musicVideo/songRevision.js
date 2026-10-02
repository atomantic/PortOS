/** Explicit, fork-scoped song revision. Never advances on boot or selects audio automatically. */
import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject, mutateProjectRecord } from './projects.js';
import { applyProjectPatch } from './projectsLogic.js';
import { parseLyricCues } from './timedText.js';
import { musicVideoEvents } from './events.js';

const inflight = new Map();
const fail = (message, code = 'SONG_REVISION_CONFLICT') => { throw new ServerError(message, { status: 409, code }); };
const defaults = { generate: async (...args) => (await import('./autonomousSuno.js')).generateSunoSong(...args) };
let deps = defaults;
export const __setSongRevisionDepsForTests = (overrides = {}) => { deps = { ...defaults, ...overrides }; };

function requireRevision(project, id) {
  if (!project.parentProjectId) fail('Fork a version before revising its song');
  if (!project.songRevision || project.songRevision.id !== id) fail('This song revision is no longer current');
  return project.songRevision;
}
async function mutate(id, fn) {
  const out = await mutateProjectRecord(id, (current) => {
    const next = fn(current);
    return { ...next, project: { ...next.project, updatedAt: new Date().toISOString(),
      songRevision: { ...next.project.songRevision, sequence: (current.songRevision?.sequence || 0) + 1 } } };
  });
  musicVideoEvents.emit('song-revision', { projectId: id, project: out.project });
  return out;
}
const patch = (id, revisionId, fn) => mutate(id, (project) => {
  const revision = requireRevision(project, revisionId);
  return { project: { ...project, songRevision: { ...revision, ...fn(revision), updatedAt: new Date().toISOString() } } };
});

export async function saveSongRevision(projectId, fields) {
  return mutate(projectId, (project) => {
    if (!project.parentProjectId) fail('Fork a version before revising its song');
    if (inflight.has(projectId) || ['generating', 'review', 'selected'].includes(project.songRevision?.status)) fail('Select or cancel the current candidates; fork again after selecting a song');
    const previous = project.songRevision;
    const revision = { id: `mvsr-${randomUUID()}`, fields, status: 'draft', songIds: [], candidates: [], createdAt: new Date().toISOString() };
    return { project: { ...project, songRevision: revision,
      songRevisionHistory: previous ? [...(project.songRevisionHistory || []), previous] : (project.songRevisionHistory || []),
    } };
  });
}

async function generate(projectId, revisionId, controller) {
  try {
    controller.signal.throwIfAborted();
    let revision = (await getProject(projectId)).songRevision;
    const persist = async (update) => {
      const out = await patch(projectId, revisionId, (r) => update(r));
      revision = out.project.songRevision;
    };
    const accept = async (song) => {
      controller.signal.throwIfAborted();
      await persist((r) => ({ candidates: [...r.candidates.filter((c) => c.songId !== song.songId), { songId: song.songId, filename: song.filename } ] }));
    };
    if (!revision.songIds.length) {
      // Reserve before dispatch. A crash without returned ids must NEVER repeat Create.
      await persist(() => ({ submitted: true }));
      const song = await deps.generate(revision.fields, {
        signal: controller.signal,
        onSubmitted: (songIds) => persist(() => ({ songIds })),
      });
      await accept(song);
    }
    for (const songId of revision.songIds) {
      controller.signal.throwIfAborted();
      if (revision.candidates.some((c) => c.songId === songId)) continue;
      const song = await deps.generate(revision.fields, { songIds: [songId], signal: controller.signal });
      await accept(song);
    }
    controller.signal.throwIfAborted();
    await patch(projectId, revisionId, (r) => r.status === 'canceled' ? {} : { status: 'review', error: null });
  } catch (err) {
    // Background work owns its failures; cancellation leaves the source/master intact.
    await patch(projectId, revisionId, (r) => r.status === 'canceled' ? {} : {
      status: 'failed', error: err.code || 'SONG_GENERATION_FAILED',
    }).catch((writeError) => console.error(`❌ Song revision could not store failure: ${writeError.code || 'STORE_FAILED'}`));
  } finally {
    inflight.delete(projectId);
  }
}

export async function generateSongRevision(projectId, revisionId) {
  if (inflight.has(projectId)) fail('Song generation is already in progress');
  const controller = new AbortController();
  // Install the reservation before any await; cancellation can always find it.
  const pending = { controller, promise: null };
  inflight.set(projectId, pending);
  const out = await patch(projectId, revisionId, (r) => {
    if (!['draft', 'failed', 'generating'].includes(r.status)) fail('Save a new draft to generate another song');
    if (r.submitted && !r.songIds.length) fail('The previous submission has an unknown outcome. Check Suno before saving a new draft.', 'SONG_SUBMISSION_UNKNOWN');
    return { status: 'generating', error: null };
  }).catch((err) => { inflight.delete(projectId); throw err; });
  pending.promise = generate(projectId, revisionId, controller);
  return out;
}

export async function cancelSongRevision(projectId, revisionId) {
  const out = await patch(projectId, revisionId, (r) => {
    if (r.status === 'selected') fail('The selected song is already applied; fork another version to revise it');
    return { status: 'canceled' };
  });
  inflight.get(projectId)?.controller.abort();
  return out;
}

export async function selectSongRevision(projectId, revisionId, songId) {
  return mutate(projectId, (project) => {
    const revision = requireRevision(project, revisionId);
    if (inflight.has(projectId) || !['review', 'failed'].includes(revision.status)) fail('Wait for candidate generation to settle before selecting audio');
    if (project.status === 'rendering' || project.autonomousRun?.status === 'running' || project.productionRuns?.some((r) => r.status === 'running')) fail('Stop active production before replacing the master audio');
    const candidate = revision.candidates.find((c) => c.songId === songId);
    if (!candidate) fail('Import and listen to a candidate before selecting it');
    const { cues, markers } = parseLyricCues(revision.fields.instrumental ? '' : revision.fields.lyrics);
    const next = applyProjectPatch(project, { trackId: null, uploadedAudioFilename: candidate.filename, lyricCues: cues, lyricMarkers: markers, phrases: [] });
    if (next.productionReview) next.productionReview = { ...next.productionReview,
      draft: { ...next.productionReview.draft, timingStatus: 'provisional' }, alignmentBasis: null,
      approvals: next.productionReview.approvals?.art ? { art: next.productionReview.approvals.art } : {}, proof: null,
    };
    return { project: { ...next, songRevision: { ...revision, status: 'selected', selectedSongId: songId, selectedAt: new Date().toISOString() } } };
  });
}

export const __testing = { settle: async () => { await Promise.all([...inflight.values()].map((entry) => entry.promise)); } };
