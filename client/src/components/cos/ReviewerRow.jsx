import { X } from 'lucide-react';
import { MAX_REVIEWER_MAX_ROUNDS } from './constants';

// Shared row grid, one template for the header and every row so their columns
// cannot drift apart. The wide form keeps minimum tracks for order, provider,
// model, effort, optional, max, and remove — together ~32rem, so the collapse is
// keyed to a CONTAINER query (`@4xl`), not a viewport one: this picker also
// renders inside a narrow dashboard tile on a wide screen, where a viewport
// `sm:` was unconditionally true and forced the wide grid into a ~250px column.
// Below `@4xl` a row collapses to a stacked 2-column label/value block, so a
// narrow container never scrolls horizontally. The header is wide-only — in the
// stacked form each cell carries its own inline label, since a header far above
// a stacked row doesn't associate.
const WIDE_TRACKS = '@4xl:grid-cols-[auto_minmax(5rem,1fr)_minmax(8rem,2fr)_minmax(7rem,1fr)_auto_3.25rem_auto]';
const ROW_CLASS = `min-w-0 grid grid-cols-[auto_minmax(0,1fr)] ${WIDE_TRACKS} items-center gap-x-2 gap-y-1 px-1.5 py-1.5 rounded border border-port-border bg-port-bg @4xl:border-transparent @4xl:bg-transparent @4xl:py-0.5 @4xl:rounded-none`;
export const CELL_LABEL_CLASS = '@4xl:hidden text-[10px] uppercase tracking-wide text-gray-400';
export const HEADER_CLASS = `hidden @4xl:grid ${WIDE_TRACKS} items-center gap-x-2 px-1.5 text-[10px] uppercase tracking-wide text-gray-400`;

export default function ReviewerRow({
  title, id, token, subject, optional, maxRounds, disabled, onToggleOptional, onMaxRounds, onRemove, warning, children,
}) {
  const inputId = `${id}-max-${token}`;
  const optionalTitle = token.startsWith('@')
    ? optional
      ? `${subject} is non-blocking (~opt): if it never submits a review, the merge isn't blocked. Click to make it blocking.`
      : `${subject} gates the merge. Click to make it non-blocking (~opt) — a missing/timed-out review from it won't block the merge.`
    : optional
      ? `${subject} is non-blocking (~opt): an inconclusive verdict from it won't block the merge. Click to make it blocking.`
      : `${subject} gates the merge. Click to make it non-blocking (~opt) — its inconclusive verdicts won't block the merge (a hard failure still does).`;
  return (
    <div className={ROW_CLASS} title={title}>
      {children}
      <span className={CELL_LABEL_CLASS}>Optional</span>
      <div>
        <button
          type="button"
          disabled={disabled}
          onClick={onToggleOptional}
          title={optionalTitle}
          className={`min-h-9 min-w-9 text-xs font-mono leading-none px-1 py-0.5 rounded border ${optional
            ? 'text-port-warning border-port-warning/50 bg-port-warning/10'
            : 'text-gray-400 border-transparent hover:text-gray-300 hover:border-port-border'} disabled:opacity-40`}
          aria-pressed={optional}
          aria-label={optional ? `Make ${subject} blocking` : `Make ${subject} non-blocking`}
        >
          ~opt
        </button>
      </div>
      <span className={CELL_LABEL_CLASS}>Max iterations</span>
      <div>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_REVIEWER_MAX_ROUNDS}
          step={1}
          disabled={disabled}
          value={maxRounds === undefined ? '' : maxRounds}
          placeholder="–"
          onChange={(e) => onMaxRounds(e.target.value)}
          aria-label={`Max review rounds for ${subject}`}
          title={maxRounds === undefined
            ? `${subject} uses slashdo's built-in round cap. Enter a number to cap its review → fix → re-review cycles (0 = loop until clean).`
            : maxRounds === 0
              ? `${subject} loops until clean (~max=0), bounded by slashdo's safety guardrail. Clear to restore the built-in cap.`
              : `${subject} runs at most ${maxRounds} review round${maxRounds === 1 ? '' : 's'} (~max=${maxRounds}). Clear to restore the built-in cap.`}
          className={`w-12 px-1 py-0.5 text-[11px] font-mono leading-none text-center rounded border bg-port-bg min-h-[28px] disabled:opacity-40 focus:outline-none focus:border-port-accent ${maxRounds === undefined
            ? 'text-gray-500 border-port-border/60 hover:border-port-border'
            : 'text-port-accent-2 border-port-accent-2/50'}`}
        />
      </div>
      <div className="col-span-2 @4xl:col-span-1 justify-self-end">
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 min-h-9 min-w-9 flex items-center justify-center text-gray-500 hover:text-port-error"
          aria-label={`Remove ${subject}`}
        >
          <X size={12} />
        </button>
      </div>
      {warning && <p className="col-span-2 @4xl:col-span-7 text-xs text-port-warning break-words">{warning}</p>}
    </div>
  );
}
