import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import CollapsibleSection from '../ui/CollapsibleSection';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter';
import toast from '../ui/Toast';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import useMounted from '../../hooks/useMounted';
import { getSelfInstance } from '../../services/apiSystem';
import { getCatalogIngredientDetails, listCatalogIngredients, previewCatalogMerge, applyCatalogMerge, listCatalogMergeHistory, getCatalogMergeReceipt, recoverCatalogMerge } from '../../services/apiCatalog';
import { formatCount, formatDateTime } from '../../utils/formatters';
import { humanizeIntegrityField } from '../../lib/characterIntegrity';

const buttonClass = 'min-h-[44px] px-3 py-2 rounded border border-port-border text-sm text-port-accent disabled:opacity-50';
const valueText = (value) => value == null ? 'Not set' : typeof value === 'string' ? value || 'Empty' : JSON.stringify(value, null, 2);

function RecordValues({ title, record }) {
  return <details className="min-w-0 rounded border border-port-border p-3">
    <summary className="cursor-pointer text-sm font-medium">{title}</summary>
    <dl className="mt-3 space-y-3 text-xs">
      {[['name', record?.name], ['tags', record?.tags], ...Object.entries(record?.payload || {}).map(([key, value]) => [`payload/${key}`, value])].map(([key, value]) => (
        <div key={key}><dt className="text-gray-500">{key.startsWith('payload/') ? `Canon ${humanizeIntegrityField(key.slice(8))}` : humanizeIntegrityField(key)}</dt>
          <dd className="whitespace-pre-wrap break-words text-gray-300">{valueText(value)}</dd></div>
      ))}
    </dl>
  </details>;
}

export default function CatalogMergePanel({ record, disabledReason, onChanged, onPendingChange }) {
  const [params] = useSearchParams();
  return <CollapsibleSection label="Local consolidation" size="bar" defaultOpen={params.has('mergeSource') || params.has('mergeReceipt')}
    className="bg-port-card border border-port-border rounded-lg p-4" bodyClassName="pt-3">
    <MergeManager key={`${record.id}:${record.updatedAt || ''}`} record={record} disabledReason={disabledReason}
      onChanged={onChanged} onPendingChange={onPendingChange} />
  </CollapsibleSection>;
}

function MergeManager({ record, disabledReason, onChanged, onPendingChange }) {
  const [params, setParams] = useSearchParams();
  const sourceId = params.get('mergeSource') || '';
  const [self, setSelf] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState(false);
  useEffect(() => {
    let active = true;
    setLoadError(null);
    getSelfInstance({ silent: true })
      .then((identity) => {
        if (!active) return;
        if (!identity?.instanceId || identity.instanceId === 'unknown') throw new Error('Merge management data is unavailable');
        setSelf(identity);
      }).catch((err) => { if (active) setLoadError(err.message); });
    return () => { active = false; };
  }, [record.id, loadVersion]);

  const blocked = disabledReason || (record.payload?.locked !== false ? 'This record is locked. Consolidation never unlocks records.'
    : self && record.originInstanceId !== self.instanceId ? 'This record does not belong to this instance.' : null);
  const fetchCandidates = useCallback(async ({ cursor, signal }) => {
    const offset = cursor || 0;
    const page = await listCatalogIngredients({ type: record.type, q: search, limit: 24, offset, signal, silent: true });
    if (!Array.isArray(page?.items)) throw new Error('Candidate search is unavailable');
    return { items: page.items, nextCursor: page.items.length === 24 ? offset + page.items.length : null };
  }, [record.type, search]);
  const candidates = usePagedCollection(fetchCandidates, { enabled: !!self && !blocked && !finished });
  const eligible = candidates.items.filter((item) => item.id !== record.id && item.type === record.type
    && item.originInstanceId === self?.instanceId && item.payload?.locked === false);
  const chooseSource = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('mergeSource', id); else next.delete('mergeSource');
    setParams(next, { replace: !!sourceId });
  };


  return <div className="space-y-4 text-gray-300">
    <p className="text-sm">Consolidate two identities on this instance. Matching names do not prove they are the same subject. The current record survives; the source remains recoverable and unchanged for peers.</p>
    <p className="text-xs text-gray-500">Only local records of the same type that are already unlocked are eligible. No records are permanently purged.</p>
    {loadError && <div role="alert">{loadError} <button type="button" className={buttonClass} onClick={() => setLoadVersion((v) => v + 1)}>Retry management data</button></div>}
    {!self && !loadError && <p role="status">Loading consolidation management…</p>}
    {blocked && <p role="status" className="text-port-warning">{blocked}</p>}
    {self && !blocked && !finished && <>
      <form onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }} className="flex flex-wrap gap-2 items-end">
        <div className="min-w-0 flex-1"><label htmlFor="merge-source-search" className="block text-xs mb-1">Find another {record.type}</label>
          <input id="merge-source-search" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)}
            className="w-full bg-port-bg rounded border border-port-border p-2" /></div>
        <button type="submit" disabled={busy} className={buttonClass}>Search candidates</button>
      </form>
      <ul className="space-y-2">{eligible.map((item) => <li key={item.id} className="min-w-0 rounded border border-port-border p-3 flex flex-wrap justify-between gap-2">
        <div className="min-w-0"><p>{item.name}</p><p className="text-xs break-all text-gray-500">{item.id}</p></div>
        <button type="button" disabled={busy} className={buttonClass} onClick={() => chooseSource(item.id)} aria-pressed={sourceId === item.id}>Select {item.name}</button>
      </li>)}</ul>
      {candidates.loaded && !eligible.length && <p className="text-xs">No eligible candidates in the loaded results. Search by name or load more.</p>}
      <InfiniteScrollFooter hasMore={candidates.hasMore} loading={candidates.loading} error={candidates.error}
        onLoadMore={candidates.loadMore} autoLoad={false} label="Load more candidates" />
    </>}
    {sourceId && self && !finished && <MergeProposal key={sourceId} sourceId={sourceId} survivor={record} instanceId={self.instanceId}
      blocked={blocked || (busy ? 'Operation in progress.' : null)} onClear={() => chooseSource('')}
      onPendingChange={(pending) => { setBusy(pending); onPendingChange?.(pending); }}
      onMerged={() => { setFinished(true); chooseSource(''); onChanged?.(); }} />}
    {finished && <p role="status">Operation completed. The record has been refreshed.</p>}
    {self && <MergeHistory record={record} blocked={blocked || (busy ? 'Operation in progress.' : null)}
      onPendingChange={(pending) => { setBusy(pending); onPendingChange?.(pending); }}
      onChanged={onChanged} />}

  </div>;
}

function MergeProposal({ sourceId, survivor, instanceId, blocked, onClear, onPendingChange, onMerged }) {
  const [source, setSource] = useState(null);
  const [choices, setChoices] = useState({});
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [loadVersion, setLoadVersion] = useState(0);
  const alive = useMounted();
  useEffect(() => {
    let active = true;
    setSource(null); setError(null);
    getCatalogIngredientDetails(sourceId, { silent: true }).then((result) => {
      if (!active) return;
      if (!result?.ingredient) throw new Error('Source record not found');
      setSource(result.ingredient);
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [sourceId, loadVersion]);
  const reason = blocked || (source && (source.id === survivor.id ? 'These URLs already resolve to the same identity.'
    : source.type !== survivor.type ? 'Both records must have the same type.'
    : source.originInstanceId !== instanceId ? 'The selected source does not belong to this instance.'
    : source.payload?.locked !== false ? 'The selected source is locked. Consolidation never unlocks it.' : null));
  const makePreview = async () => {
    if (!source || busy || reason) return;
    setBusy(true); setError(null); setPreview(null); setConfirmed(false); onPendingChange?.(true);
    try {
      const result = await previewCatalogMerge({ sourceId: source.id, survivorId: survivor.id, fieldChoices: choices }, { silent: true });
      if (!result?.previewToken || !Array.isArray(result.conflicts) || !result.proposed) throw new Error('The consolidation preview is unavailable. Please try again.');
      if (alive.current) setPreview(result);
    } catch (err) { if (alive.current) setError(err.message); }
    finally { if (alive.current) setBusy(false); onPendingChange?.(false); }
  };
  const apply = async () => {
    if (!source || busy || reason || !confirmed || !preview?.previewToken || preview.conflicts?.length) return;
    setBusy(true); setError(null); onPendingChange?.(true);
    try {
      const result = await applyCatalogMerge({ sourceId: source.id, survivorId: survivor.id, fieldChoices: choices, previewToken: preview.previewToken }, { silent: true });
      if (result?.merged !== true) throw new Error('Consolidation was not confirmed. Reload the record and inspect consolidation history.');
      if (alive.current) { toast.success('Local identities consolidated'); onMerged?.(); }
    } catch (err) { if (alive.current) { setError(err.message); setPreview(null); setConfirmed(false); } }
    finally { if (alive.current) setBusy(false); onPendingChange?.(false); }
  };
  return <section aria-label="Consolidation preview" className="border border-port-border rounded-lg p-3 space-y-3">
    <h3 className="text-sm font-semibold">Keep {survivor.name} as the surviving identity</h3>
    <p className="text-xs break-all">Survivor: {survivor.id} · Source: {sourceId}</p>
    <button type="button" className={buttonClass} disabled={busy} onClick={onClear}>Clear source selection</button>
    {reason && <p role="status" className="text-port-warning">{reason}</p>}
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {!source && !error && <p role="status">Loading source details…</p>}
    {!source && error && <button type="button" className={buttonClass} onClick={() => setLoadVersion((v) => v + 1)}>Retry source details</button>}
    {source && <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3"><RecordValues title="Survivor before consolidation" record={survivor} /><RecordValues title="Source before consolidation" record={source} /></div>
      <button type="button" disabled={busy || !!reason} className={buttonClass} onClick={makePreview}>{busy ? 'Working…' : 'Preview consolidation'}</button>
      {preview && <>
        {preview.conflicts.map((conflict) => <fieldset key={conflict.path} className="border border-port-warning/40 rounded p-3 space-y-2" disabled={busy}>
          <legend className="text-xs px-1">Resolve {conflict.path.split('/').filter(Boolean).map(humanizeIntegrityField).join(' / ')}</legend>
          {['survivor', 'source'].map((side) => <label key={side} className="flex gap-2 items-start text-xs">
            <input type="radio" name={`merge-${conflict.path}`} checked={choices[conflict.path] === side} onChange={() => {
              setChoices((current) => ({ ...current, [conflict.path]: side })); setConfirmed(false);
            }} />
            <span className="min-w-0"><strong>{side === 'survivor' ? 'Keep survivor value' : 'Use source value'}</strong><span className="block whitespace-pre-wrap break-words">{valueText(conflict[side])}</span></span>
          </label>)}
        </fieldset>)}
        <p className="text-xs text-gray-500">{Object.entries(preview.counts || {}).map(([key, count]) => `${formatCount(count)} ${key}`).join(' · ')} preserved in the recovery receipt.</p>
        <RecordValues title="Proposed survivor after consolidation" record={preview.proposed} />
        {!!preview.conflicts.length && <p className="text-xs text-port-warning">Choose every conflicting value, then preview again to review the updated result.</p>}
        {!preview.conflicts.length && <>
          <label className="flex gap-2 items-start text-sm"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />I confirm these are the same subject and have reviewed the proposed result.</label>
          <button type="button" className={buttonClass} disabled={busy || !!reason || !confirmed} onClick={apply}>Consolidate locally</button>
        </>}
      </>}
    </>}
  </section>;
}

function MergeHistory({ record, blocked, onPendingChange, onChanged }) {
  const [params, setParams] = useSearchParams();
  const receiptId = params.get('mergeReceipt');
  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const result = await listCatalogMergeHistory(record.id, { limit: 10, offset: cursor || 0, signal, silent: true });
    if (!Array.isArray(result?.items)) throw new Error('Consolidation history is unavailable');
    return { items: result.items, nextCursor: result.nextOffset };
  }, [record.id]);
  const history = usePagedCollection(fetchPage);
  const inspect = (id) => {
    const next = new URLSearchParams(params);
    if (id) next.set('mergeReceipt', id); else next.delete('mergeReceipt');
    setParams(next, { replace: !!receiptId });
  };
  return <section aria-label="Consolidation history" className="space-y-3">
    <h3 className="text-sm font-semibold">Consolidation history</h3>
    {history.loaded && !history.items.length && <p className="text-xs text-gray-500">No local consolidations recorded.</p>}
    {history.items.map((receipt) => <div key={receipt.id} className="rounded border border-port-border p-3 space-y-2">
      <p className="text-xs break-all">{receipt.sourceId} → {receipt.survivorId}</p>
      <p className="text-xs text-gray-500">{formatDateTime(receipt.createdAt)}{receipt.restoredAt ? ` · Recovered ${formatDateTime(receipt.restoredAt)}` : ''}</p>
      <p className="text-xs text-gray-500">{Object.entries(receipt.counts || {}).map(([key, count]) => `${formatCount(count)} ${key}`).join(' · ')} archived</p>
      <button type="button" className={buttonClass} onClick={() => inspect(receipt.id)}>Inspect originals</button>
    </div>)}
    <InfiniteScrollFooter hasMore={history.hasMore} loading={history.loading} error={history.error}
      onLoadMore={history.loadMore} autoLoad={false} label="Load more history" />
    {receiptId && <MergeReceipt key={receiptId} id={receiptId} ingredientId={record.id} blocked={blocked}
      onPendingChange={onPendingChange} onChanged={onChanged} onClose={() => inspect(null)} />}
  </section>;
}

function MergeReceipt({ id, ingredientId, blocked, onPendingChange, onChanged, onClose }) {
  const [receipt, setReceipt] = useState(null);
  const [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState(false);
  const alive = useMounted();
  useEffect(() => {
    let active = true;
    setReceipt(null); setError(null);
    getCatalogMergeReceipt(id, { silent: true }).then((result) => {
      if (!active) return;
      if (!Array.isArray(result?.beforeState?.ingredients) || ![result.sourceId, result.survivorId].includes(ingredientId)) throw new Error('This receipt does not belong to the current record.');
      setReceipt(result);
    }).catch((err) => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [id, ingredientId, loadVersion]);
  const recover = async () => {
    if (busy || blocked || !receipt) return;
    setBusy(true); setError(null); onPendingChange?.(true);
    try {
      const result = await recoverCatalogMerge(id, { silent: true });
      if (result?.restored !== true) throw new Error('Recovery was not confirmed. Reload the record and inspect consolidation history.');
      if (!alive.current) return;
      setArmed(false); toast.success('Local consolidation recovered'); onChanged?.();
    } catch (err) { if (alive.current) setError(err.message); }
    finally { if (alive.current) setBusy(false); onPendingChange?.(false); }
  };
  return <section aria-label="Archived consolidation" className="space-y-3 border border-port-border p-3 rounded">
    <button type="button" disabled={busy} className={buttonClass} onClick={onClose}>Close archived originals</button>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {!receipt && !error && <p role="status">Loading archived originals…</p>}
    {!receipt && error && <button type="button" className={buttonClass} onClick={() => setLoadVersion((v) => v + 1)}>Retry archived originals</button>}
    {receipt && <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">{receipt.beforeState.ingredients?.map((item) =>
        <RecordValues key={item.id} title={`Archived original: ${item.name}`} record={item} />)}</div>
      {!receipt.restoredAt && (armed ? <ConfirmButtonPair prompt="Recover the archived local state? Later edits or new locks will block recovery."
        confirmText="Recover consolidation" onConfirm={recover} onCancel={() => setArmed(false)} busy={busy || !!blocked} largeTouchTargets />
        : <button type="button" className={buttonClass} disabled={!!blocked || busy} onClick={() => setArmed(true)}>Recover this consolidation</button>)}
    </>}
  </section>;
}
