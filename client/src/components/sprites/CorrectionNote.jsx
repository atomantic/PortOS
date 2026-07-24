/**
 * Shared per-direction anchor correction note (#2964).
 *
 * The ReferenceWorkflow anchor grid and the asset-collection card render the
 * SAME control writing the SAME page-owned `corrections` map (lifted to
 * `Sprites.jsx`), so the placeholder, aria-label, and updater shape live in one
 * place and can't drift between the two surfaces. `className` lets each host
 * keep its own chrome (full grid tile vs. compact toggle-revealed card).
 *
 * `onChange` receives a setState-style updater so it composes with the
 * page-owned `setCorrections` while preserving sibling directions' notes.
 */
/**
 * Build the anchor re-roll request fragment for a direction's shared correction
 * (#2964). Returns `{ correctionPrompt }` only when the note is non-empty after
 * trimming, else `{}` — so an absent or whitespace-only note is omitted from the
 * request, matching the server's optional `correctionPrompt`. BOTH re-roll
 * surfaces spread this (the ReferenceWorkflow anchor grid and the asset card via
 * Sprites' `generateAnchor`), so they send byte-identical payloads — the single
 * source guarantee at the request layer, not just the input layer.
 */
export function correctionPromptPayload(corrections, direction) {
  const note = corrections?.[direction]?.trim();
  return note ? { correctionPrompt: note } : {};
}

export default function CorrectionNote({ direction, value, onChange, className = '' }) {
  return (
    <textarea
      value={value || ''}
      onChange={(e) => onChange((prev) => ({ ...prev, [direction]: e.target.value }))}
      rows={2}
      aria-label={`Correction guidance for the ${direction} pose`}
      placeholder="Correction (optional), e.g. no pocket on the right sleeve"
      className={`w-full px-1.5 py-1 bg-port-bg border border-port-border rounded text-gray-300 placeholder-gray-600 resize-y focus:border-port-accent focus:outline-none ${className}`}
    />
  );
}
