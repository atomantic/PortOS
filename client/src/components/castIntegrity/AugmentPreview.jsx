import { Check, Loader2 } from 'lucide-react';
import { humanizeIntegrityField } from '../../lib/characterIntegrity';

/**
 * The before/after review block for a character-augmentation proposal
 * (#6415 / #6417), shared by the Universe cast panel and the Writers Room
 * synced review's Cast pane.
 *
 * The rule this renders — and the reason it is one component rather than two —
 * is that a proposal is applied ONE TICKED FIELD AT A TIME. Both columns are
 * always shown, so the author is deciding against what is currently written
 * rather than against a blank; an empty `before` says "(empty)" out loud rather
 * than rendering as an ambiguous gap. `Apply` stays disabled until something is
 * ticked, so a model's rewrite can never land by momentum.
 *
 * Purely presentational: the propose/apply calls and their state live in
 * `hooks/useCharacterAugmentation.js`.
 */
export default function AugmentPreview({
  preview, accepted, applying, onToggleField, onDiscard, onApply, idPrefix = 'augment',
}) {
  if (!preview) return null;
  return (
    <div className="rounded border border-port-accent/40 bg-port-bg p-3 space-y-3">
      <h3 className="text-xs uppercase tracking-wider text-gray-400">
        Proposed for {preview.entryName} — tick what to keep
      </h3>
      {preview.proposals.map((p) => {
        const id = `${idPrefix}-${p.field.replace(/[^a-zA-Z0-9]/g, '-')}`;
        return (
          <div key={p.field} className="space-y-1">
            <label htmlFor={id} className="flex items-center gap-2 text-xs text-gray-200">
              <input
                type="checkbox"
                id={id}
                checked={accepted.has(p.field)}
                onChange={() => onToggleField(p.field)}
                className="accent-port-accent"
              />
              <span className="font-mono text-[11px]">{humanizeIntegrityField(p.field)}</span>
            </label>
            <div className="grid gap-2 sm:grid-cols-2">
              <p className="text-[11px] text-gray-500 border border-port-border rounded p-2 whitespace-pre-wrap">
                {p.before || <span className="italic">(empty)</span>}
              </p>
              <p className="text-[11px] text-gray-200 border border-port-accent/40 rounded p-2 whitespace-pre-wrap">{p.after}</p>
            </div>
            {p.rationale ? <p className="text-[11px] text-gray-500 italic">{p.rationale}</p> : null}
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onDiscard} className="px-2 py-1 text-xs text-gray-400 hover:text-white">
          Discard
        </button>
        <button
          type="button"
          onClick={onApply}
          disabled={applying || accepted.size === 0}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-port-accent text-white text-xs disabled:opacity-40"
        >
          {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          Apply {accepted.size || ''}
        </button>
      </div>
    </div>
  );
}
