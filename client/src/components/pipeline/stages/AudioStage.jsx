import { useEffect, useRef, useState } from 'react';
import { ListMusic, Loader2 } from 'lucide-react';
import toast from '../../ui/Toast';
import { listPipelineMusicGenerators, updatePipelineIssue } from '../../../services/apiPipeline.js';
import AudioCuesSection from './AudioCuesSection';
import AudioDialogueLines from './AudioDialogueLines';
import AudioMusicSection from './AudioMusicSection';

// The whole-episode audio strategy (#863). 'per-clip' keeps each stitched
// clip's own soundtrack (today's default); 'silent' strips it; 'generated'
// lays an arc-driven cues[] bed across the timeline; 'uploaded-track' loops a
// single attached/generated music pointer.
const AUDIO_MODES = [
  { id: 'per-clip', label: 'Per-clip audio', hint: "Keep each stitched clip's own soundtrack." },
  { id: 'silent', label: 'Silent', hint: 'Strip clip audio — voice-over plays over silence.' },
  { id: 'generated', label: 'Generated cues', hint: 'Arc-driven music cues laid across the episode timeline.' },
  { id: 'uploaded-track', label: 'Single track', hint: 'Loop one attached/uploaded music track under the whole episode.' },
];

export default function AudioStage({ issue, onStageUpdate }) {
  return <AudioStageContent key={issue.id} issue={issue} onStageUpdate={onStageUpdate} />;
}

function AudioStageContent({ issue, onStageUpdate }) {
  const stage = issue.stages?.audio ?? { status: 'empty', lines: [] };
  const audioMode = AUDIO_MODES.some((mode) => mode.id === stage.audioMode) ? stage.audioMode : 'per-clip';
  const [audioModeSaving, setAudioModeSaving] = useState(false);
  const [generators, setGenerators] = useState(null);
  const [generatorsError, setGeneratorsError] = useState(null);
  const loadingGenerators = useRef(false);

  // Cues and single-track generation share one engine discovery request.
  const loadGenerators = async (force = false) => {
    if (loadingGenerators.current || generators || (generatorsError && !force)) return;
    loadingGenerators.current = true;
    setGeneratorsError(null);
    try {
      const result = await listPipelineMusicGenerators({ silent: true });
      setGenerators(result);
    } catch (err) {
      const message = err.message || 'Failed to load generators';
      toast.error(message);
      setGeneratorsError(message);
    } finally {
      loadingGenerators.current = false;
    }
  };

  useEffect(() => {
    if (audioMode === 'generated') void loadGenerators();
  }, [audioMode]);

  // The selected backend's descriptor (models + duration window + readiness).
  // Falls back to the legacy single-engine shape when the server predates the
  // `engines` array, so an older API still drives the picker.
  const genEngines = generators?.engines ?? (generators
    ? [{
        id: generators.defaultEngine || 'musicgen',
        name: 'MusicGen',
        models: generators.models || [],
        defaultModelId: generators.defaultModelId,
        defaultDurationSec: generators.defaultDurationSec,
        minDurationSec: generators.minDurationSec,
        maxDurationSec: generators.maxDurationSec,
        installEnv: 'INSTALL_MUSICGEN',
        ready: generators.ready,
        unavailableReason: generators.unavailableReason,
      }]
    : []);

  // Persist a new whole-episode audio mode via the existing issue PATCH route,
  // then lift the returned issue so the UI reflects the saved mode.
  const handleAudioModeChange = async (mode) => {
    if (mode === audioMode) return;
    setAudioModeSaving(true);
    // Custom error toast below → silent so the helper doesn't double-toast.
    const result = await updatePipelineIssue(
      issue.id,
      { stages: { audio: { audioMode: mode } } },
      { silent: true },
    ).catch((err) => {
      toast.error(err.message || 'Failed to set audio mode');
      return null;
    });
    setAudioModeSaving(false);
    if (!result) return;
    onStageUpdate?.('audio', result.stages?.audio, result);
    // The `audioMode` effect will land the generators list for 'generated';
    // no explicit fetch needed here.
  };

  const generatorStatus = { generators, generatorsError, genEngines, loadGenerators };

  return (
    <div className="@container/audio-stage space-y-4">
      <AudioDialogueLines issue={issue} stage={stage} onStageUpdate={onStageUpdate}>
        {/* Whole-episode audio mode (#863) — drives the episode's non-dialogue
            audio at stitch time. */}
        <section className="p-3 bg-port-card border border-port-border rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <ListMusic className="w-4 h-4 text-port-accent" />
            <label htmlFor="audio-mode" className="text-sm font-medium text-white">Episode audio</label>
            {audioModeSaving ? <Loader2 size={12} className="animate-spin text-gray-500" /> : null}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <select
              id="audio-mode"
              value={audioMode}
              disabled={audioModeSaving}
              onChange={(e) => void handleAudioModeChange(e.target.value)}
              className="px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm disabled:opacity-50"
            >
              {AUDIO_MODES.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
            <p className="text-xs text-gray-500 min-w-0 flex-1 basis-48">
              {AUDIO_MODES.find((m) => m.id === audioMode)?.hint}
            </p>
          </div>
        </section>
        <AudioCuesSection
          issueId={issue.id}
          cues={stage.cues}
          audioMode={audioMode}
          audioModeSaving={audioModeSaving}
          generatorStatus={generatorStatus}
          onStageUpdate={onStageUpdate}
        />
      </AudioDialogueLines>
      <AudioMusicSection issueId={issue.id} music={stage.music} generatorStatus={generatorStatus} onStageUpdate={onStageUpdate} />
    </div>
  );
}
