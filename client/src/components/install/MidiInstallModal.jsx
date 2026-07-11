/**
 * First-use installer for the MuScriptor (audio → MIDI) runtime. A thin preset
 * over RuntimeInstallModal pointed at /api/midi-runtime/install — opened by
 * useMidiTranscription when the transcribe kickoff returns 503
 * MIDI_RUNTIME_MISSING, so clicking Transcribe on a fresh install bootstraps the
 * venv in-app (like the image/video model runtimes) and then auto-continues the
 * transcription on completion.
 */

import RuntimeInstallModal from './RuntimeInstallModal';

export default function MidiInstallModal({ open, onClose, onComplete }) {
  return (
    <RuntimeInstallModal
      open={open}
      runtime="muscriptor"
      label="MuScriptor (MIDI transcription)"
      installUrlBase="/api/midi-runtime/install"
      description="Installing the MuScriptor runtime and Python packages (large download on first run)…"
      onClose={onClose}
      onComplete={onComplete}
    />
  );
}
