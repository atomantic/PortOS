/**
 * Render the `{ text, changed }` runs from `diffWords` into React nodes —
 * changed runs get native deletion/insertion marks and colored highlights, unchanged
 * runs render as bare text. Shared by `InlineDiff` (stacked) and
 * `SideBySideDiff` (columnar) so the highlight markup stays in one place.
 */

export const renderRuns = (runs, added) => runs.map((run, i) => {
  if (!run.changed) return run.text;
  const Mark = added ? 'ins' : 'del';
  return (
    <Mark key={i} className={added ? 'bg-port-success/20 text-port-success underline' : 'bg-port-error/20 text-port-error line-through'}>
      {run.text}
    </Mark>
  );
});
