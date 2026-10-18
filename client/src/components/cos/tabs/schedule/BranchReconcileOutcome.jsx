import { formatCount, formatDateTime } from '../../../../utils/formatters';

const STATUS_LABELS = { drained: 'No remaining work in last scan', incomplete: 'Incomplete', running: 'Sweep running' };

// A persisted scan describes convergence independently of coordinator success.
// Paths and lock text are display data, never executable recovery instructions.
export default function BranchReconcileOutcome({ outcomes, apps }) {
  if (!outcomes || !Object.keys(outcomes).length) return null;
  return (
    <div className="mx-4 mb-3 space-y-2 text-xs">
      {Object.entries(outcomes).map(([appId, outcome]) => (
        <details key={appId} className="rounded border border-port-border p-2">
          <summary className="cursor-pointer text-gray-300">
            {apps?.find(app => app.id === appId)?.name || (appId === 'null' ? 'Repository' : appId)}
            {' · '}{STATUS_LABELS[outcome.status] || 'Outcome unavailable'}
            {Array.isArray(outcome.remaining) && ` · ${formatCount(outcome.remaining.length)} remaining`}
          </summary>
          <div className="mt-2 space-y-2 text-gray-400">
            <p>{outcome.observedAt ? `Last inventory: ${formatDateTime(outcome.observedAt)}` : 'No readable inventory yet.'}</p>
            {outcome.reason && <p className="break-words">Reason: {outcome.reason}</p>}
            {outcome.nextAction && <p>{outcome.nextAction}</p>}
            {!Array.isArray(outcome.remaining) && <p>Remaining work is unknown.</p>}
            <ul className="space-y-2 max-h-64 overflow-y-auto">
              {(outcome.remaining || []).map((entry, index) => (
                <li key={`${entry.path || entry.branch || entry.issue || entry.reason}:${index}`} className="break-words border-t border-port-border pt-2">
                  <p className="text-gray-300">{entry.branch || (entry.detached ? 'Detached checkout' : entry.issue ? `Issue #${entry.issue}` : 'Repository scan')}: {entry.reason}</p>
                  {entry.path && <p className="break-all">{entry.path}</p>}
                  {entry.head && <p className="break-all">HEAD: {entry.head}</p>}
                  {entry.locked && <p>Lock: {entry.lockReason || 'No reason recorded'}</p>}
                  {entry.managed === false && <p>Outside managed worktree roots</p>}
                </li>
              ))}
            </ul>
            {(outcome.remaining || []).some(entry => entry.path) && (
              <p>Checkout recovery requires verified owner authority or a scoped release, fresh ownership and merge checks, and a verified archive of unique tracked, untracked and ignored content. Lock age, an absent process, and lock text do not prove release. Keep active owners and manual handoffs protected.</p>
            )}
          </div>
        </details>
      ))}
    </div>
  );
}
