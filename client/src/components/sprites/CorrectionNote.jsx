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
