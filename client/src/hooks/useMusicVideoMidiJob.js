import { useState } from 'react';
import toast from '../components/ui/Toast';
import {
  transcribeMusicVideoMidi,
  musicVideoMidiEventsUrl,
  cancelMusicVideoMidiTranscription,
} from '../services/apiMusicVideo.js';
import useMidiTranscription from './useMidiTranscription.js';
import { DEFAULT_MUSCRIPTOR_MODEL } from '../lib/muscriptorModels.js';

/**
 * Audio → MIDI transcription (MuScriptor) bound to the music-video API surface:
 * turn the project's source audio into a .mid. The server persists the pointer
 * on the project at completion; the terminal frame carries it, handed to
 * `onTranscribed(projectId, midiTranscription)` keyed on the captured projectId
 * (the job's `context`) so a project switch mid-transcription can't misattribute
 * the result.
 *
 * The MuScriptor model size lives here so the picker and the kickoff can't
 * disagree — `startRequest` reads it fresh each kickoff (useSseJobSlot invokes
 * the latest closure), so a change applies to the next run.
 *
 * Returns the underlying `useMidiTranscription` slot (active/stage/stageLabel/
 * context/start/cancel/installGate/gatedGate) plus `model` / `setModel`.
 */
export default function useMusicVideoMidiJob({ onTranscribed } = {}) {
  const [model, setModel] = useState(DEFAULT_MUSCRIPTOR_MODEL);
  const job = useMidiTranscription({
    startRequest: (projectId) => transcribeMusicVideoMidi(projectId, { model }, { silent: true }),
    eventsUrl: musicVideoMidiEventsUrl,
    cancelRequest: cancelMusicVideoMidiTranscription,
    onComplete: (frame, projectId) => {
      if (frame.discarded) {
        toast.info('The track changed during transcription — MIDI result discarded');
        return;
      }
      if (frame.midiTranscription) onTranscribed?.(projectId, frame.midiTranscription);
      toast.success('MIDI transcription ready');
    },
  });
  return { ...job, model, setModel };
}
