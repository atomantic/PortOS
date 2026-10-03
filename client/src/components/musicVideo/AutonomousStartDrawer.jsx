import CodeAuthoringPicker from './CodeAuthoringPicker.jsx';
import MediaModePicker from './MediaModePicker.jsx';
import AutoApproveFields from './AutoApproveFields.jsx';
import { useState } from 'react';
import { Wand2 } from 'lucide-react';
import Drawer from '../Drawer.jsx';
import ToggleChip from '../ui/ToggleChip.jsx';
import ToolPicker from './ToolPicker.jsx';
import MoodBoardPicker from './MoodBoardPicker.jsx';
import SongSourcePicker from './SongSourcePicker.jsx';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import MusicVideoLlmStagesPicker from './MusicVideoLlmStagesPicker.jsx';
import toast from '../ui/Toast';
import useProviderModels from '../../hooks/useProviderModels.js';
import { startAutonomousMusicVideo } from '../../services/apiMusicVideo.js';
import {
  AUTONOMOUS_CHECKPOINT_IDS, AUTONOMOUS_CHECKPOINT_LABELS, SUNO_LIMITS, SUNO_VOCAL_GENDERS, autonomousRequestFromDraft, emptyAutonomousDraft,
  isSunoModelValid,
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
  const [authoringReady, setAuthoringReady] = useState(false);
  const llm = useProviderModels({ allowDefault: true, silent: true, withEffort: true });
  const [effort, setEffort] = useState('');
  // An explicit per-run grant, authorized by the signed-in session.
  const [autoApprove, setAutoApprove] = useState([]);
  const [grantError, setGrantError] = useState(null);
  const patch = (next) => setDraft((d) => ({ ...d, ...next }));
  const toggleCheckpoint = (id) => patch({
    checkpoints: AUTONOMOUS_CHECKPOINT_IDS.filter((c) => (c === id ? !draft.checkpoints.includes(c) : draft.checkpoints.includes(c))),
  });
  const patchSuno = (next) => setDraft((d) => ({ ...d, suno: { ...d.suno, ...next } }));
  const sunoModelValid = draft.songSource !== 'suno' || isSunoModelValid(draft.suno.model);
  const valid = draft.prompt.trim().length > 0 && authoringReady && sunoModelValid;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setGrantError(null);
    startAutonomousMusicVideo(
      {
        ...autonomousRequestFromDraft(draft, { providerId: llm.selectedProviderId || undefined, model: llm.selectedModel || undefined, effort: effort || undefined }),
        ...(autoApprove.length ? { autoApprove } : {}),
      },
      { silent: true },
    )
      .then(({ project }) => {
        setDraft(emptyAutonomousDraft());
        setAutoApprove([]);
        toast.success('Autonomous music video started');
        onStarted(project);
      })
      .catch((err) => {
        if (err?.code === 'AUTH_REQUIRED') setGrantError(err.message);
        else toast.error(err?.message || 'Failed to start the autonomous music video');
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      size="md"
      title="Autonomous music video"
      subtitle="One prompt in — lyrics, a song, visual direction and an authored video"
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
            The agent develops visual direction from this prompt within your selected media mode.
          </p>
        </div>

        <SongSourcePicker idPrefix="mv-auto" songSource={draft.songSource} localFallback={draft.localFallback} localMusic={draft.localMusic} onChange={patch} />

        {draft.songSource === 'suno' && (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,10rem),16rem))] gap-3">
            <div>
              <label htmlFor="mv-auto-suno-exclude" className="block text-xs text-port-text-muted mb-1">Exclude styles</label>
              <input id="mv-auto-suno-exclude" type="text" maxLength={SUNO_LIMITS.excludeStyles} value={draft.suno.excludeStyles} onChange={(e) => patchSuno({ excludeStyles: e.target.value })} placeholder="metal, screamo" className={inputClass} />
            </div>
            {!draft.instrumental && (
              <div>
                <label htmlFor="mv-auto-suno-vocal" className="block text-xs text-port-text-muted mb-1">Vocal gender</label>
                <select id="mv-auto-suno-vocal" value={draft.suno.vocalGender} onChange={(e) => patchSuno({ vocalGender: e.target.value })} className={inputClass}>
                  <option value="">Suno decides</option>
                  {SUNO_VOCAL_GENDERS.map((gender) => <option key={gender} value={gender}>{gender === 'male' ? 'Male' : 'Female'}</option>)}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="mv-auto-suno-model" className="block text-xs text-port-text-muted mb-1">Suno model</label>
              <input id="mv-auto-suno-model" type="text" maxLength={10} value={draft.suno.model} onChange={(e) => patchSuno({ model: e.target.value })} placeholder="Current (e.g. v6)" aria-invalid={!sunoModelValid} className={inputClass} />
              {!sunoModelValid && <p className="text-[11px] text-port-error mt-1">Use a version such as v6 or v6-wild.</p>}
            </div>
            <div>
              <label htmlFor="mv-auto-suno-max" className="block text-xs text-port-text-muted mb-1">Max Mode</label>
              <select id="mv-auto-suno-max" value={draft.suno.maxMode} onChange={(e) => patchSuno({ maxMode: e.target.value })} className={inputClass}>
                <option value="">Suno decides</option>
                <option value="on">On (higher quality, more credits)</option>
                <option value="off">Off</option>
              </select>
            </div>
          </div>
        )}

        <ToggleChip id="mv-auto-instrumental" label="Instrumental (no vocals)" checked={draft.instrumental} onToggle={() => patch({ instrumental: !draft.instrumental })} />

        <MediaModePicker id="mv-auto-media-mode" value={draft.mediaMode} onChange={(mediaMode) => patch({ mediaMode })} />
        <CodeAuthoringPicker value={draft.authoring} onChange={(authoring) => patch({ authoring })} onValidityChange={setAuthoringReady} disabled={submitting} />
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
          <p className="text-[11px] text-port-text-muted mt-1">Select automatic planning approvals below if desired. The animated proof always needs a recorded review.</p>
        </fieldset>

        <AutoApproveFields
          idPrefix="mv-auto"
          value={autoApprove}
          onChange={(next) => { setAutoApprove(next); setGrantError(null); }}
          error={grantError}
        />

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
            label="Direction LLM (brief, lyrics and every stage on Default)"
            disabled={submitting}
            modelDisabled={llm.availableModels.length === 0}
            compact
          />
        )}

        <MusicVideoLlmStagesPicker
          idPrefix="mv-auto-start"
          value={draft.llmStages}
          onChange={(llmStages) => patch({ llmStages })}
          lyricsReview={draft.lyricsReview}
          onLyricsReviewChange={(lyricsReview) => patch({ lyricsReview })}
          disabled={submitting}
        />

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
