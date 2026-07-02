/**
 * Render the `{ text, changed }` runs from `diffWords` into React nodes —
 * changed runs get a red (removed) or green (added) highlight span, unchanged
 * runs render as bare text. Shared by `InlineDiff` (stacked) and
 * `SideBySideDiff` (columnar) so the highlight markup stays in one place.
 */

export const renderRuns = (runs, added) =>
  runs.map((run, i) => (run.changed ? (
    <span key={i} className={added ? 'bg-port-success/20 text-port-success' : 'bg-port-error/20 text-port-error'}>
      {run.text}
    </span>
  ) : (
    run.text
  )));
