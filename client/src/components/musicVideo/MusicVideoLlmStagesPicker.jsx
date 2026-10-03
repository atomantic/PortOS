import { useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import ToggleChip from '../ui/ToggleChip.jsx';
import MusicVideoLlmPicker from './MusicVideoLlmPicker.jsx';
import { MUSIC_VIDEO_LLM_STAGES, MUSIC_VIDEO_LLM_STAGE_LABELS } from '../../lib/musicVideoAutomation.js';

/**
 * "Models per stage" — a collapsible list of the Music Video LLM stages, each
 * with its own provider / model / effort (MusicVideoLlmPicker). A stage left on
 * "Default" runs on the direction LLM; the server resolves the order (request
 * pin → stage pin → direction pin → an eligible TUI → the active provider, see
 * services/musicVideo/llmRoute.js).
 *
 * `value` is the draft map `{ [stage]: { providerId, model, effort } }` (only
 * pinned stages); `onChange` receives the next map. `stages` narrows the list
 * to the stages a surface can actually run. When `onLyricsReviewChange` is
 * given, a "Review lyrics with a second model" toggle is shown too. Pickers
 * mount only while the section is open, so a collapsed section loads nothing.
 */
export default function MusicVideoLlmStagesPicker({
  idPrefix, value, onChange, stages = MUSIC_VIDEO_LLM_STAGES, lyricsReview = false, onLyricsReviewChange = null, disabled = false,
}) {
  const current = value || {};
  const pinned = stages.filter((stage) => current[stage]?.providerId);
  const [open, setOpen] = useState(pinned.length > 0);
  const bodyId = `${idPrefix}-llm-stages`;
  const reviewPinned = !!current.lyricsReview?.providerId;

  // Several rows can clear a vanished provider in the same commit; each builds on
  // the map the previous one produced rather than on this render's stale copy.
  const latest = useRef(current);
  latest.current = current;
  const setStage = (stage, llm) => {
    const { [stage]: _previous, ...rest } = latest.current;
    latest.current = llm?.providerId ? { ...rest, [stage]: llm } : rest;
    onChange(latest.current);
  };
  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="min-w-0 border border-port-border rounded p-2" data-testid={`${idPrefix}-llm-stages`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex items-center gap-1 text-xs text-port-text-muted min-h-[44px] sm:min-h-0"
      >
        <Chevron size={14} aria-hidden="true" />
        Models per stage
        <span className="text-[11px]">{pinned.length ? `· ${pinned.length} pinned` : '· all use the direction LLM'}</span>
      </button>
      {open && (
        <div id={bodyId} className="mt-2 space-y-3 min-w-0">
          <p className="text-[11px] text-port-text-muted">
            A stage on Default runs on the direction LLM. Pin a cheap model to draft and a stronger one to review, plan or author code.
          </p>
          {onLyricsReviewChange && (
            <ToggleChip
              id={`${idPrefix}-lyrics-review`}
              label={reviewPinned ? 'Review lyrics with a second model (on: review stage pinned)' : 'Review lyrics with a second model'}
              hint="After the draft, a second pass revises the lyrics for scansion and punch, keeping the title, sections and length"
              checked={lyricsReview || reviewPinned}
              onToggle={() => { if (!disabled && !reviewPinned) onLyricsReviewChange(!lyricsReview); }}
            />
          )}
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,16rem),1fr))] gap-3">
            {stages.map((stage) => (
              <MusicVideoLlmPicker
                key={stage}
                idPrefix={`${idPrefix}-stage-${stage}`}
                label={MUSIC_VIDEO_LLM_STAGE_LABELS[stage]}
                value={current[stage]}
                onChange={(llm) => setStage(stage, llm)}
                emptyProviderOption="Default (use direction LLM)"
                fallbackName="Default"
                hint={null}
                disabled={disabled}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
