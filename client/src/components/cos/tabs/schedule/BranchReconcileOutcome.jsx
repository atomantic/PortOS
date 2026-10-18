import { useState } from 'react';
import { formatCount, formatDateTime } from '../../../../utils/formatters';
import { retireBranchReconcileCheckout } from '../../../../services/api';

const STATUS_LABELS = { drained: 'No remaining work in last scan', incomplete: 'Incomplete', running: 'Sweep running' };

// Only a post-cleanup inventory row carries the exact checkout identity a
// scoped release must name; branch-only holds have nothing to release.
const isInventoriedCheckout = entry => Boolean(entry.path && entry.head && typeof entry.locked === 'boolean');
const checkoutKey = (appId, entry) => `${appId}\0${entry.path}\0${entry.head}`;
const NONE = new Set();

// The confirmation IS the scoped release: it names this row's path, HEAD,
// branch and lock text, and the server refuses if any of them changed since.
function RetireCheckout({ appId, entry, onRetired }) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const retire = async () => {
    setState('pending');
    setError(null);
    const result = await retireBranchReconcileCheckout({
      appId, path: entry.path, head: entry.head, branch: entry.branch ?? null, locked: entry.locked, lockReason: entry.lockReason ?? null,
    }, { silent: true }).catch(err => {
      setError(err?.message || 'Checkout retirement failed');
      return null;
    });
    if (!result) {
      setState('idle');
      return;
    }
    onRetired(checkoutKey(appId, entry));
  };
  if (state === 'idle') {
    return (
      <div className="pt-1">
        <button type="button" className="text-port-accent hover:underline" onClick={() => setState('confirming')}>Archive and retire checkout…</button>
        {error && <p role="alert" className="text-port-error break-words">{error}</p>}
      </div>
    );
  }
  return (
    <div className="mt-1 space-y-1 rounded border border-port-warning/50 p-2">
      <p className="text-gray-300">
        Release this exact checkout{entry.locked ? ' and its lock' : ''}? Tracked edits, untracked and ignored files are archived first
        {entry.branch ? `, then the checkout and branch ${entry.branch} are removed` : ', then the checkout is removed'}. A changed lock, HEAD or a live owner keeps everything in place.
      </p>
      <div className="flex gap-2">
        <button type="button" className="rounded border border-port-border px-2 py-1" disabled={state === 'pending'} onClick={() => setState('idle')}>Cancel</button>
        <button type="button" className="rounded bg-port-error/80 px-2 py-1 text-white disabled:opacity-50" disabled={state === 'pending'} onClick={retire}>
          {state === 'pending' ? 'Archiving…' : 'Yes, archive and retire'}
        </button>
      </div>
    </div>
  );
}

// A persisted scan describes convergence independently of coordinator success.
// Paths and lock text are display data, never executable recovery instructions.
export default function BranchReconcileOutcome({ outcomes, apps }) {
  // Hides a retired row at once. Scoped to the outcomes it was retired from:
  // the schedule event's fresh inventory is authoritative once it arrives.
  const [retired, setRetired] = useState({ source: outcomes, keys: NONE });
  const retiredKeys = retired.source === outcomes ? retired.keys : NONE;
  if (!outcomes || !Object.keys(outcomes).length) return null;
  const markRetired = key => setRetired(current => ({
    source: outcomes, keys: new Set(current.source === outcomes ? current.keys : NONE).add(key),
  }));
  return (
    <div className="mx-4 mb-3 space-y-2 text-xs">
      {Object.entries(outcomes).map(([appId, outcome]) => {
        const remaining = Array.isArray(outcome.remaining) ? outcome.remaining.filter(entry => !retiredKeys.has(checkoutKey(appId, entry))) : null;
        return (
          <details key={appId} className="rounded border border-port-border p-2">
            <summary className="cursor-pointer text-gray-300">
              {apps?.find(app => app.id === appId)?.name || (appId === 'null' ? 'Repository' : appId)}
              {' · '}{STATUS_LABELS[outcome.status] || 'Outcome unavailable'}
              {remaining && ` · ${formatCount(remaining.length)} remaining`}
            </summary>
            <div className="mt-2 space-y-2 text-gray-400">
              <p>{outcome.observedAt ? `Last inventory: ${formatDateTime(outcome.observedAt)}` : 'No readable inventory yet.'}</p>
              {outcome.reason && <p className="break-words">Reason: {outcome.reason}</p>}
              {outcome.nextAction && <p>{outcome.nextAction}</p>}
              {!remaining && <p>Remaining work is unknown.</p>}
              <ul className="space-y-2 max-h-64 overflow-y-auto">
                {(remaining || []).map((entry, index) => (
                  <li key={`${entry.path || entry.branch || entry.issue || entry.reason}:${index}`} className="break-words border-t border-port-border pt-2">
                    <p className="text-gray-300">{entry.branch || (entry.detached ? 'Detached checkout' : entry.issue ? `Issue #${entry.issue}` : 'Repository scan')}: {entry.reason}</p>
                    {entry.path && <p className="break-all">{entry.path}</p>}
                    {entry.head && <p className="break-all">HEAD: {entry.head}</p>}
                    {entry.locked && <p>Lock: {entry.lockReason || 'No reason recorded'}</p>}
                    {entry.managed === false && <p>Outside managed worktree roots</p>}
                    {appId !== 'null' && isInventoriedCheckout(entry) && <RetireCheckout appId={appId} entry={entry} onRetired={markRetired} />}
                  </li>
                ))}
              </ul>
              {(remaining || []).some(entry => entry.path) && (
                <p>Retiring a checkout is a scoped release of the exact row shown. It needs merged work, no live owner or manual handoff, and a verified archive of unique tracked, untracked and ignored content. Lock age, an absent process, and lock text never release a checkout on their own.</p>
              )}
              {Array.isArray(outcome.retired) && outcome.retired.length > 0 && (
                <div>
                  <p className="text-gray-300">Recently retired</p>
                  <ul className="space-y-1">
                    {outcome.retired.map(item => (
                      <li key={`${item.path}:${item.retiredAt}`} className="break-all">
                        {item.branch || 'Detached checkout'} · {formatDateTime(item.retiredAt)} · archive {item.archiveDir}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </details>
        );
      })}
    </div>
  );
}
