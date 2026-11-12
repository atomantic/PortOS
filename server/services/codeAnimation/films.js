/** Machine-local Production film adapter. Explicit actions only; no provider calls. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { PATHS } from '../../lib/paths.js';
import { normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { makePathResolver } from '../../lib/pathSafety.js';
import { UPLOAD_AUDIO_EXTENSIONS } from '../../lib/mimeTypes.js';
import { createKeyCachedQueue } from '../../lib/createKeyCachedQueue.js';
import { validateRequest } from '../../lib/validation.js';
import { createFilmSchema, patchFilmSchema, filmAudioSchema } from '../../lib/codeAnimationFilms.js';
import { blenderRefusal } from '../film/workspace.js';
import { emitCodeAnimationChanged, emitCodeAnimationFilm } from '../socket.js';
import * as store from './projectStore.js';

const audioIn = (source, filename) => makePathResolver(() => source === 'upload' ? PATHS.uploads : PATHS.music,
  { extensions: UPLOAD_AUDIO_EXTENSIONS })(filename);
const queueAudio = createKeyCachedQueue();

export async function requireFilmProject(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw blenderRefusal('Invalid project id', 'VALIDATION_ERROR');
  const project = await store.getProjectRecord(id);
  if (!project || project.kind !== 'film') throw blenderRefusal('Film project not found', 'NOT_FOUND', 404);
  return project;
}

export async function createFilmProject(input) {
  const { title, timeline } = validateRequest(createFilmSchema, input);
  const project = await store.createProjectRecord(randomUUID(), { kind: 'film', title,
    film: { ...normalizeBlenderRecord({ settings: { fps: timeline.fps } }), timeline, audio: { filename: null } } });
  emitCodeAnimationChanged(project.id);
  return project;
}

export async function patchFilmProject(id, input) {
  const patch = validateRequest(patchFilmSchema, input);
  const project = await store.mutateFilmProject(id, current => {
    if (patch.timeline && current.film.audio?.filename) throw blenderRefusal('Remove the soundtrack before changing the timeline; audio sets its length', 'FILM_AUDIO_TIMELINE', 409);
    return { ...(patch.title ? { title: patch.title } : {}), film: { ...current.film,
      ...(patch.timeline ? { timeline: patch.timeline, settings: { ...current.film.settings, fps: patch.timeline.fps } } : {}) } };
  });
  emitCodeAnimationChanged(id);
  emitCodeAnimationFilm(id, { kind: 'state' });
  return project;
}

/** Attaching a track explicitly analyzes it locally before committing the new timeline. */
export async function attachFilmAudio(id, input) {
  const attachment = validateRequest(filmAudioSchema, input);
  return queueAudio(id, async () => {
    await requireFilmProject(id);
    let audio = { filename: null };
    let analysis = null;
    if (attachment.source !== 'none') {
      let filename = attachment.filename;
      if (attachment.source === 'track') {
        const { getTrack } = await import('../tracks/index.js');
        const track = await getTrack(attachment.trackId);
        if (!track || track.deletedAt) throw blenderRefusal('Track not found', 'NOT_FOUND', 404);
        filename = track.audioFilename;
      }
      const absolute = filename && audioIn(attachment.source, filename);
      if (!absolute) throw blenderRefusal('Audio file not found', 'AUDIO_MISSING', 404);
      const { analyzeAudioFile } = await import('../musicVideo/audioAnalysis.js');
      analysis = await analyzeAudioFile(absolute);
      if (!analysis || !Number.isFinite(analysis.durationSec) || analysis.durationSec < 1 || analysis.durationSec > 3600) {
        throw blenderRefusal('Audio analysis must produce a duration between 1 and 3,600 seconds', 'ANALYZE_FAILED', 422);
      }
      audio = { filename, source: attachment.source };
    }
    const owner = await codeAnimationFilmOwner(id);
    const { writeBlenderSong } = await import('../film/song.js');
    const { assertInsideWithoutSymlinks } = await import('../film/workspace.js');
    await assertInsideWithoutSymlinks(owner.workspaceDir, join(owner.workspaceDir, 'song.json'));
    let wroteSong = false;
    let project;
    try {
      project = await store.mutateFilmProject(id, async current => {
        const film = { ...current.film, audio, analysis,
          timeline: { ...current.film.timeline, ...(analysis ? { durationSec: analysis.durationSec } : {}) } };
        await writeBlenderSong(filmSnapshotOwner(owner, { ...current, film }), film.settings);
        wroteSong = true;
        return { film };
      });
    } catch (error) {
      // song.json is derived context; restore it if the database could not commit.
      if (wroteSong) await writeBlenderSong(owner, (await requireFilmProject(id)).film.settings);
      throw error;
    }
    emitCodeAnimationChanged(id);
    owner.emit({ kind: 'state' });
    return project;
  });
}

export async function codeAnimationFilmOwner(id) {
  await requireFilmProject(id);
  return {
    kind: 'code-animation', id,
    workspaceDir: join(PATHS.data, 'code-animation', 'films', id),
    workspaceLabel: `data/code-animation/films/${id}`,
    async timeline() {
      const { film } = await requireFilmProject(id);
      return { ...film.timeline, fps: normalizeBlenderRecord(film).settings.fps };
    },
    async readRecord() { return (await requireFilmProject(id)).film; },
    async writeRecord(change) {
      const project = await store.mutateFilmProject(id, current => {
        const film = { ...current.film, ...change(normalizeBlenderRecord(current.film)) };
        film.timeline = { ...film.timeline, fps: film.settings.fps };
        return { film };
      });
      emitCodeAnimationChanged(id);
      return project.film;
    },
    async song() { return filmSong(await requireFilmProject(id)); },
    emit(event) { emitCodeAnimationFilm(id, event); },
  };
}

/** Public film state and accepted-output freshness share the same render snapshot. */
export async function getFilmState(owner) {
  const { getBlenderState } = await import('../film/state.js');
  const { blenderFinalsSignature } = await import('../film/renderIndex.js');
  const project = await requireFilmProject(owner.id);
  const state = await getBlenderState(owner);
  const audio = project.film.audio;
  const shots = state.manifest?.shots || [];
  const finalStale = project.acceptedOutput ? !shots.length || !!state.manifest?.problems.length
    || shots.some(shot => !state.renders[shot.id]?.final?.complete || state.renders[shot.id].final.stale)
    || project.acceptedOutput.signature !== blenderFinalsSignature(shots, state.renders) : null;
  return { ...state, finalStale, timeline: project.film.timeline, audio,
    audioUrl: audio?.filename ? `/data/${audio.source === 'upload' ? 'uploads' : 'music'}/${encodeURIComponent(audio.filename)}` : null,
    acceptedOutput: project.acceptedOutput || null };
}

function filmSong(project) {
  const { film } = project;
  if (!film.audio?.filename) return null;
  const master = audioIn(film.audio.source, film.audio.filename);
  if (!master) throw blenderRefusal('Attached audio file is missing; attach it again or remove the soundtrack', 'AUDIO_MISSING', 404);
  return { projectId: project.id, title: project.title, durationSec: film.timeline.durationSec, fps: film.settings.fps,
    audio: { master, vocalStem: null }, analysis: film.analysis, lyrics: { cues: [], markers: [] } };
}

/** Bind all readers to one persisted revision for assembly and final publication checks. */
export function filmSnapshotOwner(owner, project) {
  return { ...owner, readRecord: async () => project.film,
    timeline: async () => ({ ...project.film.timeline, fps: project.film.settings.fps }),
    song: async () => filmSong(project) };
}
