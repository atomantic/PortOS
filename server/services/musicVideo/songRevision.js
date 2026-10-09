/** Explicit, fork-scoped song revision. Never advances on boot or selects audio automatically. */
import { randomUUID } from 'crypto';
import { ServerError } from '../../lib/errorHandler.js';
import { getProject, mutateProjectRecord, cloneProject } from './projects.js';
import { applyProjectPatch, addScenes } from './projectsLogic.js';
import { parseLyricCues } from './timedText.js';
import { musicVideoEvents } from './events.js';
import { diffLyricLines, songBaseline, remapSongTimeline, remapStoryboardShots } from './songRemap.js';

const inflight = new Map();
const fail = (message, code = 'SONG_REVISION_CONFLICT') => { throw new ServerError(message, { status: 409, code }); };
const defaults = {
  generate: async (...args) => (await import('./autonomousSuno.js')).generateSunoSong(...args),
  getTrack: async (...args) => (await import('../tracks/index.js')).getTrack(...args),
  cloneProject,
  proposeShotRevisions: async (...args) => (await import('./planner.js')).proposeShotRevisions(...args),
  startRetime: async (id) => (await import('./lyricAlignJob.js')).startLyricAlign(id, { retimeSong: true }),
};

// The director's choice of the new song is the request to re-time it; a start
// that fails leaves the re-time pending for the Song step's button.
async function startRetime(out) {
  const started = await deps.startRetime(out.project.id).catch((err) => {
    console.error(`❌ Song re-time did not start for ${out.project.id}: ${err.message}`);
    return null;
  });
  return { ...out, retimeJobId: started?.jobId || null };
}
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

const productionActive = (project) => project.status === 'rendering' || project.autonomousRun?.status === 'running'
  || project.productionRuns?.some((r) => r.status === 'running');

/**
 * Put a revised song on the project as its master: compare the new lyric
 * sheet with the current lines (unchanged lines keep their cue ids), snapshot
 * the old timeline so the board can follow the song once it is re-timed, and
 * mark everything timed against the old audio as provisional. Returns the next
 * project and the fields the revision records.
 */
function applyRevisedMaster(project, { trackId = null, uploadedAudioFilename = null, lyrics = '', instrumental = false }) {
  const baseline = songBaseline(project);
  // No sheet came with the new song (lyrics null): keep the current lines and re-time them on it.
  const { cues, markers } = lyrics == null
    ? { cues: (project.lyricCues || []).map(({ text }) => ({ text })), markers: project.lyricMarkers || [] }
    : parseLyricCues(instrumental ? '' : lyrics);
  const diff = diffLyricLines(project.lyricCues || [], cues);
  const next = applyProjectPatch(project, { trackId, uploadedAudioFilename, lyricCues: diff.cues, lyricMarkers: markers, phrases: [] });
  if (next.productionReview) next.productionReview = { ...next.productionReview,
    draft: { ...next.productionReview.draft, timingStatus: 'provisional' }, alignmentBasis: null,
    approvals: next.productionReview.approvals?.art ? { art: next.productionReview.approvals.art } : {}, proof: null,
  };
  return { project: next, revision: { baseline, cueStatus: diff.cueStatus, changedFrom: diff.changedFrom,
    removedLines: diff.removed, lyricDiff: diff.counts, retime: { status: 'pending' }, sceneReview: null, sceneCounts: null,
    compositionStale: Boolean(project.composition?.document) } };
}

export async function selectSongRevision(projectId, revisionId, songId) {
  return startRetime(await mutate(projectId, (project) => {
    const revision = requireRevision(project, revisionId);
    if (inflight.has(projectId) || !['review', 'failed'].includes(revision.status)) fail('Wait for candidate generation to settle before selecting audio');
    if (productionActive(project)) fail('Stop active production before replacing the master audio');
    const candidate = revision.candidates.find((c) => c.songId === songId);
    if (!candidate) fail('Import and listen to a candidate before selecting it');
    const applied = applyRevisedMaster(project, { uploadedAudioFilename: candidate.filename,
      lyrics: revision.fields.lyrics, instrumental: revision.fields.instrumental });
    return { project: { ...applied.project, songRevision: { ...revision, ...applied.revision,
      status: 'selected', selectedSongId: songId, selectedAt: new Date().toISOString() } } };
  }));
}

/**
 * Revise the song from a track already in the music library (a Suno link the
 * director imported). Forks a new version, so the current version keeps its
 * song and video, and puts the track on the fork as its master with its lyric
 * sheet, then starts re-timing it. Resolves `{ project, retimeJobId }`.
 */
export async function reviseSongFromTrack(projectId, { trackId }) {
  const source = await getProject(projectId);
  if (!source) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  if (productionActive(source)) fail('Stop active production before revising the song');
  const track = await deps.getTrack(trackId);
  if (!track) throw new ServerError('Track not found', { status: 404, code: 'NOT_FOUND' });
  if (!track.audioFilename) fail('That track has no audio yet', 'SONG_REVISION_NO_AUDIO');
  if (track.id === source.trackId) fail('That is already this version\'s song', 'SONG_REVISION_SAME_TRACK');
  const lyrics = typeof track.lyrics === 'string' ? track.lyrics : '';
  const fork = await deps.cloneProject(projectId, { variant: 'revision', includeGeneratedMedia: true });
  return startRetime(await mutate(fork.id, (project) => {
    const applied = applyRevisedMaster(project, { trackId: track.id, lyrics: lyrics.trim() ? lyrics : null });
    const now = new Date().toISOString();
    return { project: { ...applied.project, songRevision: { id: `mvsr-${randomUUID()}`, source: 'track', trackId: track.id,
      fields: { title: String(track.title || project.name || 'Song').slice(0, 80), style: String(track.prompt || '').slice(0, 1000),
        lyrics: (lyrics.trim() ? lyrics : (project.lyricCues || []).map((c) => c.text).join('\n')).slice(0, 5000), instrumental: false },
      status: 'selected', songIds: [], candidates: [], createdAt: now, selectedAt: now, ...applied.revision } } };
  }));
}

const reviewable = (revision) => revision?.status === 'selected' && revision.baseline;

/** Mark the re-time pass started or failed; the client shows it on the Song step. */
async function markSongRetime(projectId, retime) {
  const project = await getProject(projectId);
  if (!reviewable(project?.songRevision)) return null;
  return patch(projectId, project.songRevision.id, (r) => ({ retime: { ...r.retime, ...retime } }));
}

/**
 * Once the new song is analyzed and its lyrics aligned, move the board onto
 * it: shared lines carry shots across, shots whose lines changed or were cut
 * are flagged, inserted lines get new shots. Throws when the lyrics are not
 * timed yet. A project with no revised song to carry across is returned untouched.
 */
async function remapSongRevisionBoard(projectId) {
  const current = await getProject(projectId);
  if (!reviewable(current?.songRevision)) return current;
  const out = await mutate(projectId, (project) => {
    const revision = project.songRevision;
    if (!reviewable(revision)) fail('This song revision is no longer current');
    // An instrumental song has no lines to align; its board moves through the song's length alone.
    const cues = project.lyricCues || [];
    if (cues.length && !cues.some((c) => typeof c.startSec === 'number')) fail('Align the new lyrics before re-timing the shots', 'SONG_REVISION_NOT_ALIGNED');
    const remap = remapSongTimeline(project, revision);
    const added = addScenes({ ...project, scenes: remap.scenes }, remap.newScenes);
    const sceneReview = { ...remap.sceneReview };
    for (const scene of added.scenes) sceneReview[scene.sceneId] = { status: 'new', previousLyricText: null };
    // Board order follows the song once every shot is timed.
    const timed = added.project.scenes.every((s) => typeof s.startSec === 'number');
    const scenes = timed ? [...added.project.scenes].sort((a, b) => a.startSec - b.startSec || a.order - b.order).map((s, order) => ({ ...s, order })) : added.project.scenes;
    const draft = project.productionReview?.draft;
    const storyboard = draft?.storyboard ? remapStoryboardShots(draft.storyboard, { scenes, cues: project.lyricCues, map: remap.map }) : null;
    return { project: { ...added.project, scenes,
      ...(storyboard ? { productionReview: { ...project.productionReview, draft: { ...draft, storyboard } } } : {}),
      songRevision: { ...revision, sceneReview, sceneCounts: remap.counts, retime: { status: 'done', at: new Date().toISOString() }, updatedAt: new Date().toISOString() } } };
  });
  return out.project;
}

/**
 * Re-time a revised song in one pass, as the lyric-alignment job's work:
 * analyze the new master, separate its vocal and align the lyric text on it,
 * then carry the board across. Each step is the same one the Song step runs
 * on its own; the director's single tap is the consent for all of them.
 */
export async function retimeRevisedSong(projectId, { onProgress = () => {}, isCancelled = () => false, align, analyze } = {}) {
  const checkCancel = () => {
    if (isCancelled()) throw Object.assign(new Error('cancelled'), { canceled: true });
  };
  await markSongRetime(projectId, { status: 'running', error: null });
  try {
    onProgress({ stage: 'analyzing' });
    await (analyze || (async (id) => (await import('./projectAudio.js')).analyzeProjectSong(id)))(projectId);
    checkCancel();
    const project = await getProject(projectId);
    if ((project?.lyricCues || []).length) await align(projectId, { separateVocals: true, onProgress, isCancelled });
    checkCancel();
    onProgress({ stage: 'remapping' });
    return await remapSongRevisionBoard(projectId);
  } catch (err) {
    await markSongRetime(projectId, err?.canceled ? { status: 'pending', error: null } : { status: 'failed', error: String(err?.message || err).slice(0, 300) })
      .catch((writeError) => console.error(`❌ Song re-time could not store its state: ${writeError.message}`));
    throw err;
  }
}

const pendingScenes = (revision, statuses) => Object.entries(revision.sceneReview || {})
  .filter(([, entry]) => statuses.includes(entry.status) && !entry.resolved).map(([sceneId]) => sceneId);

/** The note the shot planner reads for one shot whose lyrics the new song changed. */
function replanNote(scene, entry) {
  const now = scene.lyricText ? `"${scene.lyricText}"` : 'no lyrics (instrumental)';
  if (entry.status === 'new') return `New shot for lines the revised song added: ${now}. Plan it to fit the shots around it.`;
  return `The song was revised. This shot's lyrics were ${entry.previousLyricText ? `"${entry.previousLyricText}"` : 'instrumental'} and are now ${now}. Re-plan it for the new lyrics; keep what still fits.`;
}

/**
 * Act on the shots the song revision flagged: `replan` asks the shot planner
 * (an explicit, user-triggered LLM call) for new frame/motion prompts for the
 * changed and new shots; `remove` deletes the shots whose lines were all cut;
 * `dismiss` keeps the named shots as they are.
 */
export async function resolveSongRevisionScenes(projectId, { revisionId, action, sceneIds = null, ...route }) {
  const project = await getProject(projectId);
  if (!project) throw new ServerError('Project not found', { status: 404, code: 'NOT_FOUND' });
  const revision = requireRevision(project, revisionId);
  if (!revision.sceneReview) fail('Re-time the shots to the new song first', 'SONG_REVISION_NOT_REMAPPED');
  const statuses = action === 'remove' ? ['removed'] : action === 'replan' ? ['changed', 'new'] : ['changed', 'new', 'removed'];
  const targets = pendingScenes(revision, statuses).filter((id) => !sceneIds || sceneIds.includes(id));
  if (!targets.length) fail('There are no flagged shots left for that');
  let updates = new Map();
  if (action === 'replan') {
    if (productionActive(project)) fail('Stop active production before re-planning shots');
    const notes = targets.map((sceneId) => {
      const scene = project.scenes.find((s) => s.sceneId === sceneId);
      return scene ? { stage: 'storyboard', target: sceneId, decision: 'request-changes', text: replanNote(scene, revision.sceneReview[sceneId]) } : null;
    }).filter(Boolean);
    // The planner reads open review notes from the project, so the notes ride along in memory only.
    const planning = { ...project, productionReview: { ...project.productionReview, feedback: [...(project.productionReview?.feedback || []), ...notes] } };
    updates = await deps.proposeShotRevisions(planning, notes, route);
  }
  return mutate(projectId, (current) => {
    const live = requireRevision(current, revisionId);
    const now = new Date().toISOString();
    const done = new Set(action === 'replan' ? targets.filter((id) => updates.has(id)) : targets);
    let scenes = (current.scenes || []).map((scene) => (updates.has(scene.sceneId) ? { ...scene, ...updates.get(scene.sceneId) } : scene));
    if (action === 'remove') scenes = scenes.filter((s) => !done.has(s.sceneId)).map((s, order) => ({ ...s, order }));
    const draft = current.productionReview?.draft;
    const storyboard = draft?.storyboard && (action === 'remove'
      ? draft.storyboard.filter((shot) => !done.has(shot.sceneId))
      : draft.storyboard.map((shot) => {
        const fields = updates.get(shot.sceneId);
        return fields ? { ...shot, ...(fields.prompt ? { action: fields.prompt } : {}), ...(fields.framePrompt ? { staging: fields.framePrompt } : {}) } : shot;
      }));
    const sceneReview = Object.fromEntries(Object.entries(live.sceneReview || {}).map(([id, entry]) => [id,
      done.has(id) ? { ...entry, resolved: action === 'dismiss' ? 'kept' : action === 'remove' ? 'removed' : 'replanned', resolvedAt: now } : entry]));
    return { project: { ...current, scenes, updatedAt: now,
      ...(storyboard ? { productionReview: { ...current.productionReview, draft: { ...draft, storyboard } } } : {}),
      songRevision: { ...live, sceneReview, updatedAt: now } } };
  });
}

export const __testing = { settle: async () => { await Promise.all([...inflight.values()].map((entry) => entry.promise)); } };
