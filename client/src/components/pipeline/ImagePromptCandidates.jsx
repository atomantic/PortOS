/**
 * ImagePromptCandidates — renders the N non-destructive image-gen prompt
 * candidates returned by the panel/scene `image-prompts` endpoints (issue
 * #904). Each candidate can be copied to the clipboard or applied to the
 * source description; applying is the only mutating action and it routes
 * through the caller's `onApply` so the stage owns persistence.
 *
 * Reused by ComicPagesStage (per-panel) and StoryboardsStage (per-scene).
 */
import { Copy, Check, ClipboardCheck, X, Layers } from 'lucide-react';
import { copyToClipboard } from '../../lib/clipboard';
import { IMAGE_PROMPT_COUNT_MAX } from './stages/VisualGenSettings';

// Toolbar control for "how many image-prompt candidates to generate" (issue
// #904). Owns the clamp so both stage toolbars stay in range without
// re-implementing the same min/max/trunc each. `id` must be unique per stage
// (htmlFor pairing). The clamp runs on blur (not per-keystroke) so a transient
// empty/0 while typing isn't snapped back mid-edit.
export function PromptCountInput({ id, value, onChange }) {
  const commit = (raw) => {
    const n = Number(raw);
    onChange(Number.isFinite(n) && n >= 1
      ? Math.min(Math.trunc(n), IMAGE_PROMPT_COUNT_MAX)
      : 1);
  };
  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-gray-400" htmlFor={id}>
      <Layers size={12} />
      Prompts
      <input
        id={id}
        type="number"
        min={1}
        max={IMAGE_PROMPT_COUNT_MAX}
        value={value}
        onChange={(e) => {
          // Let a clamped value through live, but never force the field — an
          // empty/0/over-max transient stays editable until blur commits it.
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= 1 && n <= IMAGE_PROMPT_COUNT_MAX) onChange(Math.trunc(n));
        }}
        onBlur={(e) => commit(e.target.value)}
        title={`How many alternative image-gen prompts the "AI: prompts" button generates (1–${IMAGE_PROMPT_COUNT_MAX})`}
        className="w-12 px-1 py-1 bg-port-bg border border-port-border rounded text-white text-xs text-center"
      />
    </label>
  );
}

export default function ImagePromptCandidates({ candidates, onApply, onDismiss, applyingIndex = null }) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  return (
    <div className="mt-2 p-2 bg-port-bg/60 border border-port-border rounded space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-gray-500">
          {candidates.length} image-prompt candidate{candidates.length === 1 ? '' : 's'}
        </span>
        {onDismiss ? (
          <button
            type="button"
            onClick={onDismiss}
            className="text-gray-500 hover:text-gray-300 p-0.5"
            aria-label="Dismiss candidates"
          >
            <X size={12} />
          </button>
        ) : null}
      </div>
      <ul className="space-y-2">
        {candidates.map((candidate, i) => (
          <li key={candidate.runId || i} className="flex items-start gap-2 p-2 bg-port-card border border-port-border/60 rounded">
            <span className="text-[10px] text-gray-500 font-mono pt-0.5 w-5 shrink-0">{i + 1}</span>
            <p className="flex-1 text-xs text-gray-200 whitespace-pre-wrap break-words">{candidate.prompt}</p>
            <div className="flex flex-col gap-1 shrink-0">
              <button
                type="button"
                onClick={() => copyToClipboard(candidate.prompt, 'Prompt copied')}
                title="Copy this prompt to the clipboard"
                className="inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-port-card border border-port-border text-gray-300 text-[11px] hover:border-port-accent/50 hover:text-white"
              >
                <Copy size={11} /> Copy
              </button>
              {onApply ? (
                <button
                  type="button"
                  onClick={() => onApply(candidate.prompt, i)}
                  disabled={applyingIndex !== null}
                  title="Replace the description with this prompt"
                  className="inline-flex items-center justify-center gap-1 px-2 py-1 rounded bg-port-accent text-white text-[11px] hover:bg-port-accent/90 disabled:opacity-50"
                >
                  {applyingIndex === i ? <ClipboardCheck size={11} /> : <Check size={11} />}
                  Use
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
