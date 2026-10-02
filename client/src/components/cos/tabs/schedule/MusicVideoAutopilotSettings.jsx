import CodeAuthoringPicker from '../../../musicVideo/CodeAuthoringPicker.jsx';
import MediaModePicker from '../../../musicVideo/MediaModePicker.jsx';
import { useEffect, useState } from 'react';
import ToggleChip from '../../../ui/ToggleChip';
import ProviderModelSelector from '../../../ProviderModelSelector';
import ToolPicker from '../../../musicVideo/ToolPicker';
import MoodBoardPicker from '../../../musicVideo/MoodBoardPicker';
import SongSourcePicker from '../../../musicVideo/SongSourcePicker';
import useProviderModels from '../../../../hooks/useProviderModels';
import {
  AUTONOMOUS_CHECKPOINT_IDS, AUTONOMOUS_CHECKPOINT_LABELS, autopilotDraftFromParams, autopilotParamsFromDraft,
} from '../../../../lib/musicVideoAutonomous';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * Settings for the `music-video-autopilot` scheduled task, stored in
 * `taskMetadata.musicVideoAutopilot`: the same fields as the Autonomous start
 * drawer (song source, tools, per-tool models, budget, limits, checkpoints, LLM, mood
 * board) plus the Brain idea tags a run may draw from. Saved explicitly — the
 * form holds a draft so a half-edited budget never hits the server.
 */
export default function MusicVideoAutopilotSettings({ taskType, config, onUpdate, updating, setUpdating }) {
  const saved = config.taskMetadata?.musicVideoAutopilot;
  const [draft, setDraft] = useState(() => autopilotDraftFromParams(saved));
  const llm = useProviderModels({ allowDefault: true, silent: true, withEffort: true });
  const [effort, setEffort] = useState(saved?.llm?.effort || '');
  const [llmSeeded, setLlmSeeded] = useState(false);
  const patch = (next) => setDraft((d) => ({ ...d, ...next }));

  // Restore the saved writer-LLM pin once the provider catalog has loaded.
  const { setSelectedProviderId, setSelectedModel } = llm;
  const providersLoaded = llm.providers.length > 0;
  useEffect(() => {
    if (llmSeeded || !providersLoaded) return;
    if (saved?.llm?.providerId) {
      setSelectedProviderId(saved.llm.providerId);
      setSelectedModel(saved.llm.model || '');
    }
    setLlmSeeded(true);
  }, [llmSeeded, providersLoaded, saved, setSelectedProviderId, setSelectedModel]);

  const toggleCheckpoint = (id) => patch({
    checkpoints: AUTONOMOUS_CHECKPOINT_IDS.filter((c) => (c === id ? !draft.checkpoints.includes(c) : draft.checkpoints.includes(c))),
  });

  const handleSave = async (e) => {
    e.preventDefault();
    if (updating) return;
    setUpdating(true);
    // Until the catalog has seeded the picker, "no selection" means "not loaded
    // yet", not "use the install default" — keep the saved pin untouched.
    const pin = llmSeeded
      ? { providerId: llm.selectedProviderId || undefined, model: llm.selectedModel || undefined, effort: effort || undefined }
      : { providerId: saved?.llm?.providerId, model: saved?.llm?.model || undefined, effort: saved?.llm?.effort || undefined };
    const params = autopilotParamsFromDraft(draft, saved, pin);
    await onUpdate(taskType, { taskMetadata: { ...config.taskMetadata, musicVideoAutopilot: params } }).catch(() => {});
    setUpdating(false);
  };

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <p className="text-xs text-gray-500">
        Each run turns the oldest unused Brain idea into an authored music video with these settings, pausing for art, storyboard and animated proof approvals. Use Run Now under Global defaults to start one immediately.
      </p>

      <div>
        <label htmlFor="mv-ap-idea-tags" className="block text-xs text-port-text-muted mb-1">Brain idea tags (optional)</label>
        <input id="mv-ap-idea-tags" value={draft.ideaTags} onChange={(e) => patch({ ideaTags: e.target.value })} placeholder="song, music — comma separated; blank = any active idea" className={inputClass} />
      </div>

      <SongSourcePicker idPrefix="mv-ap" songSource={draft.songSource} localFallback={draft.localFallback} onChange={patch} />

      <ToggleChip id="mv-ap-instrumental" label="Instrumental (no vocals)" checked={draft.instrumental} onToggle={() => patch({ instrumental: !draft.instrumental })} />

      <MediaModePicker id="mv-auto-media-mode" value={draft.mediaMode} onChange={(mediaMode) => patch({ mediaMode })} />
      <CodeAuthoringPicker value={draft.authoring} onChange={(authoring) => patch({ authoring })} disabled={updating} />
      <ToolPicker idPrefix="mv-ap" tools={draft.tools} models={draft.models} onChange={patch} />

      <MoodBoardPicker id="mv-ap-mood-board" value={draft.moodBoardId} onChange={(moodBoardId) => patch({ moodBoardId })} />

      <div>
        <label htmlFor="mv-ap-guidance" className="block text-xs text-port-text-muted mb-1">Guidance (optional)</label>
        <textarea id="mv-ap-guidance" rows={2} maxLength={4000} value={draft.guidance} onChange={(e) => patch({ guidance: e.target.value })} className={inputClass} />
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),16rem))] gap-3">
        <div>
          <label htmlFor="mv-ap-budget" className="block text-xs text-port-text-muted mb-1">Budget cap (USD)</label>
          <input id="mv-ap-budget" type="number" min="0" step="1" value={draft.budget} onChange={(e) => patch({ budget: e.target.value })} placeholder="No cap" className={inputClass} />
        </div>
        <div>
          <label htmlFor="mv-ap-generations" className="block text-xs text-port-text-muted mb-1">Max generations</label>
          <input id="mv-ap-generations" type="number" min="1" max="500" step="1" value={draft.maxGenerations} onChange={(e) => patch({ maxGenerations: e.target.value })} className={inputClass} />
        </div>
      </div>

      <fieldset className="min-w-0" aria-labelledby="mv-ap-checkpoints-label">
        <span id="mv-ap-checkpoints-label" className="block text-xs text-port-text-muted mb-1">Pause for my approval after (optional)</span>
        <div className="flex flex-wrap gap-1.5">
          {AUTONOMOUS_CHECKPOINT_IDS.map((id) => (
            <ToggleChip key={id} id={`mv-ap-checkpoint-${id}`} label={AUTONOMOUS_CHECKPOINT_LABELS[id]} checked={draft.checkpoints.includes(id)} onToggle={() => toggleCheckpoint(id)} />
          ))}
        </div>
      </fieldset>

      {llm.providers.length > 0 && (
        <ProviderModelSelector
          providers={llm.providers}
          selectedProviderId={llm.selectedProviderId}
          selectedModel={llm.selectedModel}
          availableModels={llm.availableModels}
          onProviderChange={(id) => { llm.setSelectedProviderId(id); setEffort(''); }}
          onModelChange={llm.setSelectedModel}
          effort={effort}
          onEffortChange={setEffort}
          emptyProviderOption="Auto — a TUI provider when one is eligible"
          emptyModelOption="Provider default"
          label="Writes the brief and lyrics"
          disabled={updating}
          modelDisabled={llm.availableModels.length === 0}
          compact
        />
      )}

      <button type="submit" disabled={updating} className="w-full bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
        {updating ? 'Saving…' : 'Save settings'}
      </button>
    </form>
  );
}
