/**
 * The audio a project's song currently plays, and what to do when that file
 * was replaced in place under a track the project is still linked to (#14793).
 * Pure comparison lives in `lib/musicVideoSongAudio.js`.
 */
import { songAudioChange, keepSongTimingPatch } from '../../lib/musicVideoSongAudio.js';
import { getTrack } from '../tracks/index.js';
import { mutateProjectRecord } from './projects.js';

/** Basename of the project's current master audio, or null when it has none (or its track is gone). */
export async function currentMasterFilename(project) {
  if (project?.trackId) return (await getTrack(project.trackId))?.audioFilename || null;
  return project?.uploadedAudioFilename || null;
}

/** The change in `project`'s song audio since its timing was derived, or null. */
export async function projectSongAudioChange(project) {
  // Nothing recorded means nothing can have drifted; skip the track read.
  if (!project?.audioAnalysis?.masterFilename && !project?.lyricTimingMasterFilename) return null;
  return songAudioChange(project, await currentMasterFilename(project));
}

/** The director's explicit choice to keep the old timing against the replaced audio. */
export async function keepSongTiming(projectId) {
  const { project } = await mutateProjectRecord(projectId, async (current) => {
    const master = await currentMasterFilename(current);
    return { project: master ? { ...current, ...keepSongTimingPatch(current, master), updatedAt: new Date().toISOString() } : current };
  });
  return project;
}
