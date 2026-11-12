/**
 * song.json: what a Blender film knows about the song it is cut to. Written to
 * the workspace for authors and staged into every job, so a film reads beats,
 * sections, loudness envelopes and timed lyrics without ever calling PortOS.
 */
import { existsSync } from 'node:fs';

const numbers = (list) => (Array.isArray(list) ? list.filter((value) => Number.isFinite(value)) : []);
const timeOrNull = (value) => (Number.isFinite(value) ? value : null);

function songAnalysis(analysis) {
  const envelopes = analysis?.features?.envelopes;
  return {
    bpm: Number.isFinite(analysis?.bpm) ? analysis.bpm : null,
    beats: numbers(analysis?.beats),
    downbeats: numbers(analysis?.downbeats),
    sections: (Array.isArray(analysis?.sections) ? analysis.sections : [])
      .filter((section) => Number.isFinite(section?.startSec) && Number.isFinite(section?.endSec))
      .map((section) => ({ label: section.label || '', startSec: section.startSec, endSec: section.endSec, energy: Number.isFinite(section.energy) ? section.energy : null })),
    features: envelopes && Number.isFinite(envelopes.fps) ? {
      envelopes: { fps: envelopes.fps, rms: numbers(envelopes.rms), low: numbers(envelopes.low), mid: numbers(envelopes.mid), high: numbers(envelopes.high) },
    } : null,
  };
}

/** The song context for `project` at `fps`. Pure: `audio` carries the resolved file paths. */
function buildBlenderSong(project, { fps, audio = { master: null, vocalStem: null } }) {
  return {
    projectId: project.id,
    title: project.name || '',
    durationSec: Number.isFinite(project.audioAnalysis?.durationSec) ? project.audioAnalysis.durationSec : 0,
    fps,
    audio: { master: audio.master || null, vocalStem: audio.vocalStem || null },
    analysis: songAnalysis(project.audioAnalysis),
    lyrics: {
      cues: (Array.isArray(project.lyricCues) ? project.lyricCues : []).map((cue, index) => ({
        index,
        id: cue?.id || null,
        text: cue?.text || '',
        startSec: timeOrNull(cue?.startSec),
        endSec: timeOrNull(cue?.endSec),
        words: (Array.isArray(cue?.words) ? cue.words : [])
          .filter((word) => Number.isFinite(word?.startSec) && Number.isFinite(word?.endSec))
          .map((word) => ({ w: word.w || '', startSec: word.startSec, endSec: word.endSec })),
      })),
      markers: (Array.isArray(project.lyricMarkers) ? project.lyricMarkers : [])
        .map((marker) => ({ type: marker?.type || null, label: marker?.label || '', kind: marker?.kind || null, line: Number.isInteger(marker?.line) ? marker.line : null })),
    },
  };
}

// A film can render without the audio files (it reads the analysis); a missing
// master or stem is a null path, never a failed job.
async function songAudioPaths(project) {
  const [{ resolveProjectAudioPath }, { resolveVocalStemPath }] = await Promise.all([import('../projectAudio.js'), import('../vocalStem.js')]);
  const master = await resolveProjectAudioPath(project).then((path) => (existsSync(path) ? path : null), () => null);
  const vocalStem = await Promise.resolve().then(() => resolveVocalStemPath(project)).catch(() => null);
  return { master, vocalStem };
}

/** The exact song context a job receives, without writing the workspace. */
export const getBlenderSong = async (project, settings) => buildBlenderSong(project, { fps: settings.fps, audio: await songAudioPaths(project) });


/** Compatibility entry for workspace creation, which already holds the project. */
export async function writeBlenderSong(project, settings) {
  const [{ writeBlenderSong: writeSong }, { musicVideoFilmOwner }] = await Promise.all([
    import('../../film/song.js'), import('./owner.js'),
  ]);
  return writeSong(musicVideoFilmOwner(project.id), settings);
}
