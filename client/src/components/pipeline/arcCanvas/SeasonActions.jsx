import { useState } from 'react';
import { Plus, Loader2, Wand2, ListChecks, X, ShieldCheck } from 'lucide-react';
import toast from '../../ui/Toast';
import { createPipelineIssue, listPipelineIssues } from '../../../services/api';
import VerifyScopeHint from './VerifyScopeHint.jsx';

const VERIFY_VOLUME_SCOPE = {
  depth: 'One volume in depth — reads beat sheets (stages.idea.output) for issues that have them, falls back to synopsis depth for un-expanded issues. Boundary checks against the immediate-neighbor volumes only.',
  checks: [
    'Volume-internal arc shape (does the volume read as a complete sub-arc; does the final issue pay off the endingHook)',
    'Within-volume continuity (a character / object / beat that disappears mid-volume without resolution)',
    'Beat-level escalation (issues with beats only) — adjacent issues that plateau or contradict each other',
    'Promise drift (the volume logline / synopsis makes a promise no issue delivers — or vice versa)',
    'Boundary continuity (volume opening picks up the prior endingHook; volume endingHook seeds the next volume)',
    'Cast economy (a one-beat introduction never seen again, or a major bible character the volume never uses)',
    'Volume-scope world-entity drift',
    'Length-vs-weight mismatch obvious in isolation',
  ],
};

// Volume beat-sheet runner frame → button label. Keyed on the SSE frame's
// `type` field; see server/services/pipeline/volumeBeatsRunner.js for the
// frame shapes.
const BEATS_FRAME_LABELS = {
  start: (f) => `Starting (${f.total} issues)…`,
  'issue:start': (f) => `Generating ${f.ordinal}/${f.total} — ${f.issueTitle || `#${f.issueNumber}`}`,
  'issue:complete': (f) => `${f.ordinal}/${f.total} done`,
  'issue:skip': (f) => `Skipped ${f.ordinal}/${f.total}`,
  'issue:error': (f) => `Error on ${f.ordinal}/${f.total}`,
};

export default function SeasonActions({
  series, season, seasonLocked = false, hasArc, hasEpisodes, generatingEpisodes,
  verifying, onGenerateEpisodes, onValidateVolume, onIssuesUpdate,
  beatsActive, beatsStarting, beatsLatest, onStartBeats, onCancelBeats,
}) {
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  // Inline mode picker — surfaces only when the user clicks the button
  // (per Ask each time choice for skip-existing vs regenerate-all).
  const [beatsModePicker, setBeatsModePicker] = useState(false);
  const seasonHasContext = !!(season.logline?.trim() || season.synopsis?.trim());

  const handleAdd = async (e) => {
    e?.preventDefault();
    const title = newTitle.trim();
    if (!title) return;
    const created = await createPipelineIssue(series.id, {
      title,
      seasonId: season.id,
      // arcPosition = max(existing) + 1 — sequential within the season.
      arcPosition: null, // server will fall through to null; we'll patch right after to set position
    }, { silent: true }).catch((err) => {
      toast.error(err.message || 'Failed to create episode');
      return null;
    });
    if (!created) return;
    // Re-fetch so the issue lands in the right group.
    const refreshed = await listPipelineIssues(series.id).catch(() => null);
    if (refreshed) onIssuesUpdate(refreshed);
    setNewTitle('');
    setAdding(false);
    toast.success(`Issue / Episode "${created.title}" added`);
  };

  // Validate volume needs (1) an authored arc on the parent series and
  // (2) at least one issue under this volume — otherwise there is nothing
  // for the LLM to check against the volume's promises.
  const validateDisabledReason = !hasArc
    ? 'Generate the series arc first (the volume verifier checks against the arc)'
    : !hasEpisodes
      ? 'Add or generate at least one issue / episode first'
      : null;

  // Generate-all-beats needs episodes to iterate over; the per-issue
  // generator handles the "no arc context" case gracefully so we don't gate
  // on hasArc here.
  const beatsDisabledReason = !hasEpisodes
    ? 'Add or generate at least one issue / episode first'
    : null;

  // Human-readable status string for the in-flight button label. Terminal
  // frames (complete/canceled/error) are absorbed by the parent useEffect.
  const beatsLabel = beatsActive && beatsLatest
    ? (BEATS_FRAME_LABELS[beatsLatest.type]?.(beatsLatest) ?? null)
    : (beatsStarting ? 'Starting…' : null);

  return (
    <>
      <div className="px-3 pb-2 pt-2 border-t border-port-border/50 flex items-center gap-2 flex-wrap">
        {adding ? (
          <form onSubmit={handleAdd} className="flex items-center gap-2 flex-1">
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="Issue / Episode title…"
              className="flex-1 px-2 py-1.5 bg-port-bg border border-port-border rounded text-white text-sm"
              autoFocus
              maxLength={300}
            />
            <button
              type="submit"
              disabled={!newTitle.trim()}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-40"
            >
              <Plus size={12} /> Add
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setNewTitle(''); }}
              className="text-xs text-gray-400 hover:text-white px-2"
            >
              Cancel
            </button>
          </form>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg"
            >
              <Plus size={12} /> Add issue / episode
            </button>
            <button
              type="button"
              onClick={onGenerateEpisodes}
              disabled={generatingEpisodes || hasEpisodes || !seasonHasContext || seasonLocked}
              title={
                seasonLocked
                  ? 'Volume is locked — unlock to generate episodes'
                  : hasEpisodes
                    ? 'Volume already has issues / episodes'
                    : !seasonHasContext
                      ? 'Add a volume logline or synopsis first'
                      : 'Have an LLM plan the per-issue / per-episode breakdown'
              }
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-port-accent hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40 disabled:hover:text-port-accent"
            >
              {generatingEpisodes ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />}
              Generate issues / episodes (LLM)
            </button>
            <button
              type="button"
              onClick={() => setBeatsModePicker((v) => !v)}
              disabled={!!beatsDisabledReason || beatsActive || beatsStarting}
              title={beatsDisabledReason || `Generate beat sheets for every issue in volume ${season.number} sequentially`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40 disabled:hover:text-gray-300"
            >
              {beatsStarting || beatsActive ? <Loader2 size={12} className="animate-spin" /> : <ListChecks size={12} />}
              Generate beat sheets
            </button>
            {beatsActive ? (
              <button
                type="button"
                onClick={onCancelBeats}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-port-warning hover:text-white border border-port-warning/40 bg-port-bg hover:bg-port-warning/10"
                title="Stop the run after the current issue finishes"
              >
                <X size={12} /> Stop
              </button>
            ) : null}
            <button
              type="button"
              onClick={onValidateVolume}
              disabled={!!validateDisabledReason || verifying}
              title={validateDisabledReason || `Deep continuity pass on volume ${season.number}`}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40 disabled:hover:text-gray-300"
            >
              {verifying ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
              Validate volume
            </button>
          </>
        )}
      </div>
      {beatsModePicker && !beatsActive && !beatsStarting ? (
        <div className="mx-3 mb-2 p-2 border border-port-border rounded bg-port-bg/60 text-xs space-y-2">
          <p className="text-gray-300">
            Generate beat sheets for every issue in volume {season.number}, one at a time.
            Each prompt picks up the prior issue's freshly-written beats.
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={() => { setBeatsModePicker(false); onStartBeats('skip-existing'); }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-port-accent text-white hover:bg-port-accent/80"
              title="Only generate for issues that don't already have a beat sheet"
            >
              Skip issues with beats
            </button>
            <button
              type="button"
              onClick={() => { setBeatsModePicker(false); onStartBeats('regenerate-all'); }}
              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-port-warning/40 text-port-warning hover:bg-port-warning/10"
              title="Overwrite every issue's existing beat sheet"
            >
              Regenerate all
            </button>
            <button
              type="button"
              onClick={() => setBeatsModePicker(false)}
              className="text-gray-400 hover:text-white px-2"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {beatsLabel ? (
        <div className="px-3 pb-2 text-xs text-gray-400 flex items-center gap-2">
          <Loader2 size={12} className="animate-spin" />
          {beatsLabel}
        </div>
      ) : null}
      {!adding ? (
        <div className="px-3 pb-3">
          <VerifyScopeHint scope={VERIFY_VOLUME_SCOPE} />
        </div>
      ) : null}
    </>
  );
}
