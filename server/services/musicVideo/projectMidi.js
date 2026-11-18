/**
 * Music Video — transcribe a project's source audio to MIDI (MuScriptor,
 * audioMidiTranscription.js) and land the `midiTranscription` pointer on the
 * project. Shared by the `/transcribe-midi` route (the director's MIDI button)
 * and the autonomous run's optional "transcribe for planning" step, which
 * waits for the result.
 */

import { PATHS } from '../../lib/fileUtils.js';
import { startMidiTranscription } from '../audioMidiTranscription.js';
import { resolveProjectAudioPath } from './projectAudio.js';
import { getProject, setProjectMidiTranscription } from './projects.js';

/**
 * Kick off a transcription of `project`'s audio. Resolves `{ jobId, model }`
 * once the job is running; `onSettled(frame)` gets its terminal SSE frame.
 * Throws a 503 with the install hint when the MuScriptor runtime is missing.
 */
export async function startProjectMidiTranscription(project, { model, onSettled } = {}) {
  const audioPath = await resolveProjectAudioPath(project);
  const projectId = project.id;
  // Audio-source identity at kickoff — the completion callback re-checks it so
  // a transcription of the OLD track can't land on a project whose audio was
  // swapped mid-run (another client / peer sync). applyProjectPatch clears
  // midiTranscription on the swap; without this guard the in-flight job would
  // reintroduce the stale pointer right after.
  const sourceTrackId = project.trackId ?? null;
  const sourceUpload = project.uploadedAudioFilename ?? null;
  return startMidiTranscription({
    audioPath,
    outputName: `${project.name || 'music-video'}-midi`,
    model,
    ownerKey: projectId,
    onSettled,
    // Land the .mid in the music dir (not uploads) so the peer-sync asset
    // manifest federates it with the project's other audio — the manifest
    // only ships known asset kinds/directories, and `music` is one.
    destDir: PATHS.music,
    onComplete: async ({ filename, model: usedModel }) => {
      const current = await getProject(projectId);
      if (!current) throw new Error('Project was deleted during transcription');
      if ((current.trackId ?? null) !== sourceTrackId || (current.uploadedAudioFilename ?? null) !== sourceUpload) {
        // The service deletes the orphaned .mid and reports a discarded (not
        // "ready") completion to the client.
        return { discarded: true, reason: `audio source of ${projectId} changed mid-transcription` };
      }
      const midiTranscription = { filename, model: usedModel, createdAt: new Date().toISOString() };
      await setProjectMidiTranscription(projectId, midiTranscription);
      return { midiTranscription };
    },
  });
}

/**
 * Transcribe and wait: resolves the terminal frame (`complete` with
 * `midiTranscription`, `complete` + `discarded`, `canceled` or `error`).
 * Rejects only when the job cannot start (no runtime, no audio).
 */
export async function transcribeProjectMidi(project, { model } = {}) {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  await startProjectMidiTranscription(project, { model, onSettled: (frame) => resolveDone(frame) });
  return done;
}
