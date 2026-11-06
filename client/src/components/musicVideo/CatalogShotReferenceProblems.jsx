import { formatCount } from '../../utils/formatters.js';

/**
 * The shots whose saved references a catalog check-in cannot send, and the saved
 * references it could move to the same catalog image. Neither blocks approval.
 */
export default function CatalogShotReferenceProblems({ checkin, disabled = false, onRemap, onOpenShot }) {
  const movable = checkin?.movableShotReferences || 0;
  const problems = checkin?.shotReferenceProblems || [];
  if (!movable && !problems.length) return null;
  return (
    <div role="group" className="space-y-2 text-xs text-port-warning" aria-label="Shot references">
      {movable > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="min-w-0">{formatCount(movable)} saved shot {movable === 1 ? 'reference' : 'references'} cannot reach new renders, but the catalog offers the same {movable === 1 ? 'image' : 'images'}.</p>
          <button type="button" disabled={disabled} onClick={onRemap} className="min-h-11 rounded border border-port-border px-3 text-sm text-port-text disabled:opacity-50">Move to catalog images</button>
        </div>
      )}
      {problems.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {problems.map((problem) => (
            <li key={problem.sceneId} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 basis-48">{problem.message}</span>
              <button type="button" onClick={() => onOpenShot(problem.sceneId)} aria-label={`Open shot ${formatCount(problem.shot)}`} className="min-h-11 shrink-0 rounded border border-port-border px-3 text-port-text sm:min-h-8">Open shot</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
