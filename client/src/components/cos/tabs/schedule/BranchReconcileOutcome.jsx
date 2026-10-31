import { useId, useLayoutEffect, useRef, useState } from 'react';
import { formatCount, formatDateTime } from '../../../../utils/formatters';
import { retireBranchReconcileCheckout, reviewBranchReconcileCheckout, refreshBranchReconcileInventory } from '../../../../services/api';
import useMounted from '../../../../hooks/useMounted';

const STATUS_LABELS = { drained: 'No remaining work in last scan', incomplete: 'Incomplete', running: 'Sweep running' };

// Only a post-cleanup inventory row carries the exact checkout identity a
// scoped release must name; branch-only holds have nothing to release.
const isInventoriedCheckout = entry => Boolean(!entry.checkoutMissing && entry.path && entry.head && typeof entry.locked === 'boolean');
const checkoutKey = (appId, entry) => `${appId}\0${entry.path}\0${entry.head}`;
const NONE = new Set();

function InventoryEntry({ appId, entry, onRetired }) {
  return (
    <li className="break-words border-t border-port-border pt-2">
      <p className="text-gray-300">{entry.branch || (entry.detached ? 'Detached checkout' : entry.issue ? `Issue #${entry.issue}` : 'Repository scan')}: {entry.reason}</p>
      {entry.path && <p className="break-all">{entry.path}</p>}
      {(entry.checkoutMissing || entry.branchMissing) && <p>Original checkout or branch no longer exists. It stays unresolved, separate from current local work, until retirement evidence explains it.</p>}
      {entry.head && <p className="break-all">HEAD: {entry.head}</p>}
      {entry.locked && <p>Lock: {entry.lockReason || 'No reason recorded'}</p>}
      {entry.managed === false && <p>Outside managed worktree roots</p>}
      {appId !== 'null' && isInventoriedCheckout(entry) && <RetireCheckout key={JSON.stringify([appId, entry.path, entry.head, entry.branch, entry.locked, entry.lockReason, entry.reason])} appId={appId} entry={entry} onRetired={onRetired} />}
    </li>
  );
}

// The confirmation IS the scoped release: it names this row's path, HEAD,
// branch and lock text, and the server refuses if any of them changed since.
function RetireCheckout({ appId, entry, onRetired }) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState(null);
  const [prUrl, setPrUrl] = useState('');
  const [review, setReview] = useState(null);
  const [acceptSuperseded, setAcceptSuperseded] = useState(false);
  const inputId = useId();
  const needsReview = entry.reason === 'pr-completion-review-required';
  const release = { appId, path: entry.path, head: entry.head, branch: entry.branch ?? null, locked: entry.locked, lockReason: entry.lockReason ?? null };
  const prepareReview = async () => {
    setState('preparing'); setError(null); setReview(null); setAcceptSuperseded(false);
    const result = await reviewBranchReconcileCheckout({ ...release, prUrl }, { silent: true })
      .catch(err => { setError(err?.message || 'Checkout review failed'); return null; });
    if (result && !result.review) setError('Checkout review returned no comparison; checkout kept.');
    setReview(result?.review || null); setState('confirming');
  };
  const retire = async () => {
    setState('pending');
    setError(null);
    const result = await retireBranchReconcileCheckout({
      ...release,
      ...(needsReview ? { review: { prUrl: review.forge.prUrl, digest: review.digest, acceptSuperseded } } : {}),
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
        <button type="button" className="rounded border border-port-border px-2 py-1 text-port-accent hover:border-port-accent" onClick={() => setState('confirming')}>Retire checkout…</button>
        {error && <p role="alert" className="text-port-error break-words">{error}</p>}
      </div>
    );
  }
  return (
    <div className="mt-1 space-y-1 rounded border border-port-warning/50 p-2">
      <p className="text-gray-300">
        Retire this exact merged, clean checkout{entry.locked ? ' and its lock' : ''}?
        {entry.branch ? ` The checkout and branch ${entry.branch} are removed in place.` : ' The checkout is removed in place.'} No checkout archive is created. Dirty checkouts and checkouts with unique unverified ignored files stay in place. A changed lock, HEAD or a live owner also keeps everything in place.
      </p>
      {needsReview && <div className="space-y-2">
        <label htmlFor={inputId}>Merged pull request URL</label>
        <input id={inputId} value={prUrl} onChange={event => { setPrUrl(event.target.value); setReview(null); }} disabled={state === 'pending' || state === 'preparing'} className="w-full rounded border border-port-border bg-port-bg p-1" />
        <button type="button" onClick={prepareReview} disabled={!prUrl || state === 'pending' || state === 'preparing'} className="rounded border border-port-border px-2 py-1">{state === 'preparing' ? 'Preparing comparison…' : 'Review merged work'}</button>
        {review && <>
          <p>Compared with {review.forge.defaultBranch} at {review.forge.defaultHead}. Original work and its differences from the current default branch are shown below.</p>
          <details><summary>Original changes</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{review.comparison.localPatch || 'No original changes.'}</pre></details>
          <details><summary>Differences from current default</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all">{review.comparison.difference || 'No differences in the affected files.'}</pre></details>
          {review.comparison.disposition === 'review-supersession' && <label htmlFor={`${inputId}-superseded`} className="flex gap-2">
            <input id={`${inputId}-superseded`} type="checkbox" checked={acceptSuperseded} onChange={event => setAcceptSuperseded(event.target.checked)} />
            I reviewed these differences and confirm the current implementation supersedes this original work.
          </label>}
        </>}
      </div>}
      {error && <p role="alert" className="break-words text-port-error">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="rounded border border-port-border px-2 py-1" disabled={state === 'pending' || state === 'preparing'} onClick={() => setState('idle')}>Cancel</button>
        <button type="button" className="rounded bg-port-error/80 px-2 py-1 text-white disabled:opacity-50" disabled={state === 'pending' || state === 'preparing' || (needsReview && (!review || (review.comparison.disposition === 'review-supersession' && !acceptSuperseded)))} onClick={retire}>
          {state === 'pending' ? 'Retiring…' : 'Yes, retire checkout'}
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
  const [refreshed, setRefreshed] = useState({ source: outcomes, values: {} });
  const [refreshStates, setRefreshStates] = useState({ source: outcomes, values: {} });
  const pending = useRef(new Map());
  const latestOutcomes = useRef(outcomes);
  const mounted = useMounted();
  useLayoutEffect(() => { latestOutcomes.current = outcomes; }, [outcomes]);
  const refreshStatus = refreshStates.source === outcomes ? refreshStates.values : {};
  const retiredKeys = retired.source === outcomes ? retired.keys : NONE;
  if (!outcomes || !Object.keys(outcomes).length) return null;
  const markRetired = key => setRetired(current => ({
    source: outcomes, keys: new Set(current.source === outcomes ? current.keys : NONE).add(key),
  }));
  const refresh = async appId => {
    if (pending.current.get(appId) === outcomes) return;
    pending.current.set(appId, outcomes);
    const setStatus = value => setRefreshStates(current => ({ source: outcomes, values: { ...(current.source === outcomes ? current.values : {}), [appId]: value } }));
    setStatus({ pending: true });
    const result = await refreshBranchReconcileInventory(appId, { silent: true })
      .catch(err => ({ error: err?.message || 'Inventory refresh failed' }));
    if (pending.current.get(appId) === outcomes) pending.current.delete(appId);
    if (!mounted.current || latestOutcomes.current !== outcomes) return;
    if (!result?.outcome || result.appId !== appId) {
      setStatus({ error: result?.error || 'Refresh returned no matching inventory; previous inventory retained.' });
      return;
    }
    setRefreshed(current => ({ source: outcomes, values: { ...(current.source === outcomes ? current.values : {}), [appId]: result.outcome } }));
    setRetired(current => ({ source: outcomes, keys: new Set([...(current.source === outcomes ? current.keys : NONE)].filter(key => !key.startsWith(`${appId}\0`))) }));
    setStatus({});
  };
  return (
    <div className="mx-4 mb-3 space-y-2 text-xs">
      {Object.entries(outcomes).map(([appId, storedOutcome]) => {
        const outcome = (refreshed.source === outcomes && refreshed.values[appId]) || storedOutcome;
        const recorded = Array.isArray(outcome.remaining) ? outcome.remaining.filter(entry => !retiredKeys.has(checkoutKey(appId, entry))) : null;
        const historical = recorded?.filter(entry => entry.checkoutMissing || entry.branchMissing) || [];
        const remaining = recorded?.filter(entry => !entry.checkoutMissing && !entry.branchMissing && entry.reason !== 'remote-branch-held') ?? null;
        const remote = [...(outcome.remoteInventory?.reported || []), ...(recorded?.filter(entry => entry.reason === 'remote-branch-held') || [])];
        // Sweep interruptions and retirement can leave an incomplete outcome
        // with no recorded work. This does not establish a newly drained scan.
        const incompleteEmptyInventory = outcome.status === 'incomplete' && outcome.observedAt && remaining?.length === 0 && historical.length === 0;
        return (
          <details key={appId} className="rounded border border-port-border p-2">
            <summary className="cursor-pointer text-gray-300">
              {apps?.find(app => app.id === appId)?.name || (appId === 'null' ? 'Repository' : appId)}
              {' · '}{incompleteEmptyInventory ? 'No remaining recorded work' : STATUS_LABELS[outcome.status] || 'Outcome unavailable'}
              {remaining && ` · ${formatCount(remaining.length)} remaining`}
              {historical.length > 0 && ` · ${formatCount(historical.length)} unresolved missing checkouts`}
            </summary>
            <div className="mt-2 space-y-2 text-gray-400">
              <p>{outcome.observedAt ? `Last inventory: ${formatDateTime(outcome.observedAt)}` : 'No readable inventory yet.'}</p>
              {appId !== 'null' && <div className="space-y-1">
                <button type="button" className="rounded border border-port-border px-2 py-1 disabled:opacity-50" disabled={refreshStatus[appId]?.pending} onClick={() => refresh(appId)}>
                  {refreshStatus[appId]?.pending ? 'Refreshing inventory…' : 'Refresh inventory'}
                </button>
                <p>Rescan this repository without deleting checkouts or starting an AI agent. Missing-checkout records are retained.</p>
                {refreshStatus[appId]?.error && <p role="alert" className="break-words text-port-error">{refreshStatus[appId].error}</p>}
              </div>}
              {incompleteEmptyInventory && <p>Last sweep: Incomplete</p>}
              {outcome.reason && <p className="break-words">Reason: {outcome.reason}</p>}
              {outcome.nextAction && <p>{outcome.nextAction}</p>}
              {remote.length > 0 && (
                <details>
                  <summary className="cursor-pointer">Remote-only inventory · {formatCount(remote.length)} informational</summary>
                  <p>Local cleanup status covers this machine’s branches and checkouts. Remote-only refs may belong to another instance.</p>
                  <ul className="max-h-48 overflow-y-auto">
                    {remote.map((entry, index) => <li key={index} className="break-all">
                      {typeof entry === 'string' ? entry : `${entry.branch}: ${entry.reason}`}
                    </li>)}
                  </ul>
                </details>
              )}
              {!remaining && <p>Remaining work is unknown.</p>}
              <ul className="space-y-2 max-h-64 overflow-y-auto">
                {(remaining || []).map((entry, index) => <InventoryEntry key={`${entry.path || entry.branch || entry.issue || entry.reason}:${index}`} appId={appId} entry={entry} onRetired={markRetired} />)}
              </ul>
              {historical.length > 0 && <details>
                <summary className="cursor-pointer">Missing checkouts · {formatCount(historical.length)} unresolved</summary>
                <p>These records describe missing originals, not current branches or checkouts. Refreshing does not verify their preservation or clear their evidence.</p>
                <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                  {historical.map((entry, index) => <InventoryEntry key={`${entry.path || entry.branch}:${index}`} appId={appId} entry={entry} onRetired={markRetired} />)}
                </ul>
              </details>}
              {(remaining || []).some(isInventoriedCheckout) && (
                <p>Retiring a checkout is a scoped release of the exact row shown. It needs merged work, a clean checkout, and no live owner or manual handoff; git-ignored files are discarded with it. No checkout archive is created. Lock age, an absent process, and lock text never release a checkout on their own.</p>
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
