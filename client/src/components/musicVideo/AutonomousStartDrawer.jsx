import { useState } from 'react';
import { Wand2 } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import ToggleChip from '../ui/ToggleChip.jsx';
import ToolPicker from './ToolPicker.jsx';
import MoodBoardPicker from './MoodBoardPicker.jsx';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels.js';
import { startAutonomousMusicVideo } from '../../services/apiMusicVideo.js';
import {
  AUTONOMOUS_CHECKPOINT_IDS, AUTONOMOUS_CHECKPOINT_LABELS, AUTONOMOUS_SONG_SOURCES, AUTONOMOUS_SONG_SOURCE_LABELS, autonomousRequestFromDraft, emptyAutonomousDraft,
} from '../../lib/musicVideoAutonomous.js';

const inputClass = 'w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-sm';

/**
 * "Autonomous music video" — the alternate entry point: one prompt, no track,
 * style or board picked up front. The server writes a creative brief, lyrics and
 * a mood board, makes the song (Suno in the PortOS Browser, or a local Music
 * Studio engine), then produces the video
 * with the chosen tools. Checkpoints are optional approval stops.
 */
export default function AutonomousStartDrawer({ open, onClose, onStarted }) {
  const [draft, setDraft] = useState(emptyAutonomousDraft);
  const [submitting, setSubmitting] = useState(false);
  const llm = useProviderModels({ allowDefault: true, silent: true });
  const patch = (next) => setDraft((d) => ({ ...d, ...next }));
  const toggleCheckpoint = (id) => patch({
    checkpoints: AUTONOMOUS_CHECKPOINT_IDS.filter((c) => (c === id ? !draft.checkpoints.includes(c) : draft.checkpoints.includes(c))),
  });
  const valid = draft.prompt.trim().length > 0;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    startAutonomousMusicVideo(
      autonomousRequestFromDraft(draft, { providerId: llm.selectedProviderId || undefined, model: llm.selectedModel || undefined }),
      { silent: true },
    )
      .then(({ project }) => {
        setDraft(emptyAutonomousDraft());
        toast.success('Autonomous music video started');
        onStarted(project);
      })
      .catch((err) => toast.error(err?.message || 'Failed to start the autonomous music video'))
      .finally(() => setSubmitting(false));
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Autonomous music video"
      subtitle="One prompt in — lyrics, a song, a mood board and the video out"
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="mv-auto-prompt" className="block text-xs text-port-text-muted mb-1">Prompt</label>
          <textarea
            id="mv-auto-prompt"
            rows={4}
            maxLength={4000}
            value={draft.prompt}
            onChange={(e) => patch({ prompt: e.target.value })}
            placeholder="A courier crosses a rainy neon city at night — melancholic synthwave, a hopeful chorus."
            className={inputClass}
          />
          <p className="text-[11px] text-port-text-muted mt-1">
            The agent also builds its own mood board and visual style from this prompt.
          </p>
        </div>

        <div>
          <label htmlFor="mv-auto-song-source" className="block text-xs text-port-text-muted mb-1">Song source</label>
          <select
            id="mv-auto-song-source"
            value={draft.songSource}
            onChange={(e) => patch({ songSource: e.target.value })}
            className={inputClass}
          >
            {AUTONOMOUS_SONG_SOURCES.map((source) => (
              <option key={source} value={source}>{AUTONOMOUS_SONG_SOURCE_LABELS[source]}</option>
            ))}
          </select>
          <p className="text-[11px] text-port-text-muted mt-1">
            {draft.songSource === 'suno'
              ? 'Suno is driven through the PortOS Browser — sign in to Suno there first. It spends Suno credits.'
              : 'Rendered on this machine by a ready Music Studio engine (a lyric-capable one such as ACE-Step for vocals). Free, but it queues behind other GPU work.'}
          </p>
          {draft.songSource === 'suno' && (
            <div className="mt-2">
              <ToggleChip
                id="mv-auto-local-fallback"
                label="Render locally if Suno is unavailable"
                checked={draft.localFallback}
                onToggle={() => patch({ localFallback: !draft.localFallback })}
              />
            </div>
          )}
        </div>

        <ToggleChip id="mv-auto-instrumental" label="Instrumental (no vocals)" checked={draft.instrumental} onToggle={() => patch({ instrumental: !draft.instrumental })} />

        <ToolPicker tools={draft.tools} models={draft.models} onChange={patch} />

        <MoodBoardPicker id="mv-auto-mood-board" value={draft.moodBoardId} onChange={(moodBoardId) => patch({ moodBoardId })} />

        <div>
          <label htmlFor="mv-auto-guidance" className="block text-xs text-port-text-muted mb-1">Guidance (optional)</label>
          <textarea
            id="mv-auto-guidance"
            rows={2}
            maxLength={4000}
            value={draft.guidance}
            onChange={(e) => patch({ guidance: e.target.value })}
            placeholder="Tone, pacing, what to avoid — the agent writes and plans against this."
            className={inputClass}
          />
        </div>

        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),16rem))] gap-3">
          <div>
            <label htmlFor="mv-auto-budget" className="block text-xs text-port-text-muted mb-1">Budget cap (USD)</label>
            <input id="mv-auto-budget" type="number" min="0" step="1" value={draft.budget} onChange={(e) => patch({ budget: e.target.value })} placeholder="No cap" className={inputClass} />
          </div>
          <div>
            <label htmlFor="mv-auto-generations" className="block text-xs text-port-text-muted mb-1">Max generations</label>
            <input id="mv-auto-generations" type="number" min="1" max="500" step="1" value={draft.maxGenerations} onChange={(e) => patch({ maxGenerations: e.target.value })} className={inputClass} />
          </div>
        </div>

        <fieldset className="min-w-0" aria-labelledby="mv-auto-checkpoints-label">
          <span id="mv-auto-checkpoints-label" className="block text-xs text-port-text-muted mb-1">Pause for my approval after (optional)</span>
          <div className="flex flex-wrap gap-1.5">
            {AUTONOMOUS_CHECKPOINT_IDS.map((id) => (
              <ToggleChip
                key={id}
                id={`mv-auto-checkpoint-${id}`}
                label={AUTONOMOUS_CHECKPOINT_LABELS[id]}
                checked={draft.checkpoints.includes(id)}
                onToggle={() => toggleCheckpoint(id)}
              />
            ))}
          </div>
          <p className="text-[11px] text-port-text-muted mt-1">With none picked the run is fully unattended.</p>
        </fieldset>

        {llm.providers.length > 0 && (
          <ProviderModelSelector
            providers={llm.providers}
            selectedProviderId={llm.selectedProviderId}
            selectedModel={llm.selectedModel}
            availableModels={llm.availableModels}
            onProviderChange={llm.setSelectedProviderId}
            onModelChange={llm.setSelectedModel}
            label="Writes the brief and lyrics"
            disabled={submitting}
            modelDisabled={llm.availableModels.length === 0}
            compact
          />
        )}

        <button
          type="submit"
          disabled={!valid || submitting}
          className="w-full flex items-center justify-center gap-1 bg-port-accent text-white rounded px-2 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50"
        >
          <Wand2 size={16} /> {submitting ? 'Starting…' : 'Start autonomous video'}
        </button>
      </form>
    </Drawer>
  );
}
