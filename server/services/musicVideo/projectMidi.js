/**
 * Music Video — transcribe a project's source audio to MIDI (MuScriptor,
 * audioMidiTranscription.js) and land the `midiTranscription` pointer on the
 * project. Shared by the `/transcribe-midi` route (the director's MIDI button)
 * and the autonomous run's optional "transcribe for planning" step, which
 * waits for the result.
 */

import { PATHS } from '../../lib/fileUtils.js';
import { audioRevisionOf } from '../../lib/musicVideo/musicVideoSongAudio.js';
import { startMidiTranscription } from '../audioMidiTranscription.js';
import { emitRecordInvalidated } from '../sharing/recordEvents.js';
import { resolveProjectAudioPath } from './projectAudio.js';
import { mutateProjectRecord } from './projects.js';
import { setMidiTranscription } from './projectsLogic.js';

function savedFailure({ code, error }) {
  if (['MIDI_RUNTIME_VERSION_MISMATCH', 'MIDI_FFMPEG_MISSING', 'MIDI_AUDIO_DECODE_FAILED'].includes(code)) return error;
  if (code === 'gated_repo') return 'MuScriptor model access was denied. Accept its license on Hugging Face and add your token in Image Gen settings, then retry.';
  // Child stderr can contain paths and credentials. The project record syncs.
  return 'MuScriptor could not finish MIDI transcription. Check the PortOS server log for details.';
}

/**
 * Kick off a transcription of `project`'s audio. Resolves `{ jobId, model }`
 * once the job is running; `onSettled(frame)` gets its terminal SSE frame.
 * Throws a 503 with the install hint when the MuScriptor runtime is missing.
 */
export async function startProjectMidiTranscription(project, { model, onSettled } = {}) {
  const audioPath = await resolveProjectAudioPath(project);
  const projectId = project.id;
  // Compare inside the write so a track change cannot interleave between
  // validation and persistence. The revision also catches A → B → A swaps.
  const writeForSource = (transform) => mutateProjectRecord(projectId, (current) => {
    const sameSource = (current.trackId ?? null) === (project.trackId ?? null)
      && (current.uploadedAudioFilename ?? null) === (project.uploadedAudioFilename ?? null)
      && audioRevisionOf(current) === audioRevisionOf(project);
    if (!sameSource) return { project: current, discarded: true, skipPersist: true };
    return { project: transform(current) };
  }, { presentProject: false });
  const job = await startMidiTranscription({
    audioPath,
    outputName: `${project.name || 'music-video'}-midi`,
    model,
    ownerKey: projectId,
    onSettled: (frame) => {
      onSettled?.(frame);
      emitRecordInvalidated('musicVideoProject', projectId);
    },
    // Land the .mid in the music dir (not uploads) so the peer-sync asset
    // manifest federates it with the project's other audio — the manifest
    // only ships known asset kinds/directories, and `music` is one.
    destDir: PATHS.music,
    onComplete: async ({ filename, model: usedModel }) => {
      const midiTranscription = { filename, model: usedModel, createdAt: new Date().toISOString() };
      const outcome = await writeForSource((current) => setMidiTranscription(current, midiTranscription));
      if (outcome.discarded) return { discarded: true, reason: 'audio source changed mid-transcription' };
      return { midiTranscription };
    },
    onFailure: (frame) => writeForSource((current) => ({
      ...current,
      midiTranscriptionError: savedFailure(frame),
      updatedAt: new Date().toISOString(),
    })),
  });
  emitRecordInvalidated('musicVideoProject', projectId);
  return job;
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
