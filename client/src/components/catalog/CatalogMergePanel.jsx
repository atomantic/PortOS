import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import CollapsibleSection from '../ui/CollapsibleSection';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter';
import toast from '../ui/Toast';
import MediaImage from '../MediaImage';
import { ingredientCoverUrl, ingredientPath } from '../../lib/creativeLibraries';
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
  const searchInput = useRef(null);
  const previousSourceId = useRef(sourceId);
  useEffect(() => {
    if (previousSourceId.current && !sourceId) searchInput.current?.focus({ preventScroll: true });
    previousSourceId.current = sourceId;
  }, [sourceId]);
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
  const localCandidates = candidates.items.filter((item) => item.id !== record.id && item.type === record.type
    && item.originInstanceId === self?.instanceId);
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
    {self && !blocked && !finished && !sourceId && <>
      <form onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }} className="flex flex-wrap gap-2 items-end">
        <div className="min-w-0 flex-1"><label htmlFor="merge-source-search" className="block text-xs mb-1">Find another {record.type}</label>
          <input ref={searchInput} id="merge-source-search" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)}
            className="w-full bg-port-bg rounded border border-port-border p-2" /></div>
        <button type="submit" disabled={busy} className={buttonClass}>Search candidates</button>
      </form>
      <ul className="space-y-2">{localCandidates.map((item) => <li key={item.id} className="min-w-0 rounded border border-port-border p-3 flex flex-wrap justify-between gap-2">
        <div className="min-w-0 flex flex-1 items-center gap-3">
          <div className="w-16 h-16 shrink-0 rounded overflow-hidden border border-port-border bg-port-bg flex items-center justify-center">
            {ingredientCoverUrl(item)
              ? <MediaImage thumbnail src={ingredientCoverUrl(item)} alt={`${item.name} canonical image`} className="w-full h-full object-contain" loading="lazy" />
              : <span className="text-xs text-gray-500 text-center">No image</span>}
          </div>
          <div className="min-w-0"><p className="break-words">{item.name}</p><p className="text-xs break-all text-gray-500">{item.id}</p>{item.payload?.locked !== false && <p className="text-xs text-port-warning">Locked · unlock in its profile before consolidating</p>}</div>
        </div>
        <button type="button" disabled={busy} className={buttonClass} onClick={() => chooseSource(item.id)} aria-pressed={sourceId === item.id}>Select {item.name}</button>
      </li>)}</ul>
      {candidates.loaded && !localCandidates.length && <p className="text-xs">No local candidates in the loaded results. Search by name or load more.</p>}
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
  const [conflicts, setConflicts] = useState([]);
  const requestPending = useRef(false);
  const proposalRef = useRef(null);
  useEffect(() => { proposalRef.current?.focus({ preventScroll: true }); }, []);
  const [loadVersion, setLoadVersion] = useState(0);
  const alive = useMounted();
  useEffect(() => {
    let active = true;
    setSource(null); setError(null); setPreview(null); setConfirmed(false); setConflicts([]); setChoices({});
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
    : source.payload?.locked !== false ? 'The selected source is locked. Open its profile and unlock it, then recheck the source here. Consolidation never unlocks records.' : null));
  const makePreview = async (fieldChoices = choices) => {
    if (!source || requestPending.current || reason) return;
    requestPending.current = true;
    setBusy(true); setError(null); setPreview(null); setConfirmed(false); onPendingChange?.(true);
    try {
      const result = await previewCatalogMerge({ sourceId: source.id, survivorId: survivor.id, fieldChoices }, { silent: true });
      if (!result?.previewToken || !Array.isArray(result.conflicts) || !result.proposed) throw new Error('The consolidation preview is unavailable. Please try again.');
      if (alive.current) {
        setPreview({ ...result, fieldChoices });
        setConflicts((current) => [...current.filter((item) => !result.conflicts.some((next) => next.path === item.path)), ...result.conflicts]);
      }
    } catch (err) { if (alive.current) setError(err.message); }
    finally { requestPending.current = false; if (alive.current) setBusy(false); onPendingChange?.(false); }
  };
  const apply = async () => {
    if (!source || requestPending.current || busy || reason || !confirmed || !preview?.previewToken || preview.conflicts?.length || preview.fieldChoices !== choices) return;
    requestPending.current = true;
    setBusy(true); setError(null); onPendingChange?.(true);
    try {
      const result = await applyCatalogMerge({ sourceId: source.id, survivorId: survivor.id, fieldChoices: preview.fieldChoices, previewToken: preview.previewToken }, { silent: true });
      if (result?.merged !== true) throw new Error('Consolidation was not confirmed. Reload the record and inspect consolidation history.');
      if (alive.current) { toast.success('Local identities consolidated'); onMerged?.(); }
    } catch (err) { if (alive.current) { setError(err.message); setPreview(null); setConfirmed(false); } }
    finally { requestPending.current = false; if (alive.current) setBusy(false); onPendingChange?.(false); }
  };
  const remaining = conflicts.filter((conflict) => !choices[conflict.path]).length;
  const ready = preview && !preview.conflicts.length && preview.fieldChoices === choices;
  const chooseValue = (path, side) => {
    const next = { ...choices, [path]: side };
    setChoices(next); setConfirmed(false); setPreview(null); setError(null);
    if (conflicts.every((conflict) => next[conflict.path])) makePreview(next);
  };
  return <section ref={proposalRef} tabIndex={-1} aria-label="Consolidation preview" className="border border-port-border rounded-lg p-3 space-y-4">
    <div>
      <h3 className="text-sm font-semibold break-words">Keep {survivor.name}</h3>
      <p className="text-sm break-words">Consolidate {source?.name || 'the selected source'} into this record.</p>
      <details className="text-xs text-gray-500 mt-2"><summary className="cursor-pointer">Record IDs</summary>
        <p className="break-all">Keep: {survivor.id}</p><p className="break-all">Source: {sourceId}</p>
      </details>
    </div>
    <button type="button" className={buttonClass} disabled={busy} onClick={onClear}>Clear source selection</button>
    {reason && !busy && <div role="status" className="rounded border border-port-warning p-3 text-sm">
      <p className="font-semibold text-port-warning">Action needed before consolidation</p><p>{reason}</p>
      {source?.payload?.locked !== false && source && <div className="flex flex-wrap gap-2 mt-2">
        <a className={buttonClass} href={ingredientPath(source)} target="_blank" rel="noreferrer">Open source profile</a>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setLoadVersion((v) => v + 1)}>Recheck source</button>
      </div>}
    </div>}
    {error && <div role="alert" className="rounded border border-port-error p-3 text-sm">
      <p className="font-semibold text-port-error">Consolidation could not continue</p><p>{error}</p>
      {source && <p>Your field choices are saved. Retry the preview below before confirming.</p>}
    </div>}
    {!source && !error && <p role="status">Loading source details…</p>}
    {!source && error && <button type="button" className={buttonClass} onClick={() => setLoadVersion((v) => v + 1)}>Retry source details</button>}
    {source && <>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3"><RecordValues title="Survivor before consolidation" record={survivor} /><RecordValues title="Source before consolidation" record={source} /></div>
      {!!conflicts.length && <div className="space-y-3">
        <h4 className="font-semibold text-sm">1. Choose which values to keep</h4>
        <p className="text-sm" role="status">{remaining ? `${formatCount(remaining)} field choices remaining. Choose one value for each field below.` : 'All fields chosen. You can still change any value below.'}</p>
        {conflicts.map((conflict) => <fieldset key={conflict.path} className={`min-w-0 border rounded p-3 space-y-2 ${choices[conflict.path] ? 'border-port-border' : 'border-port-warning'}`} disabled={busy || !!reason}>
          <legend className="text-sm font-medium px-1 max-w-full break-words">{conflict.path.split('/').filter(Boolean).map(humanizeIntegrityField).join(' / ')}{choices[conflict.path] ? ' · Chosen' : ' · Needs a choice'}</legend>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
          {['survivor', 'source'].map((side) => <label key={side} htmlFor={`merge-${conflict.path}-${side}`} className="flex gap-2 items-start text-sm min-w-0 border border-port-border rounded p-3 cursor-pointer">
            <input id={`merge-${conflict.path}-${side}`} type="radio" name={`merge-${conflict.path}`} checked={choices[conflict.path] === side} onChange={() => chooseValue(conflict.path, side)} />
            <span className="min-w-0"><strong>{side === 'survivor' ? 'Keep survivor value' : 'Use source value'}</strong><span className="block text-xs text-gray-500">{side === 'survivor' ? survivor.name : source.name}</span><span className="block whitespace-pre-wrap break-words mt-1">{valueText(conflict[side])}</span></span>
          </label>)}
          </div>
        </fieldset>)}
      </div>}
      <div className="rounded border border-port-border bg-port-bg p-3 space-y-3" aria-busy={busy}>
        <h4 className="text-sm font-semibold">{conflicts.length ? '2. Review and confirm' : 'Review and confirm'}</h4>
        {busy && <p role="status">Updating consolidation…</p>}
        {!busy && remaining > 0 && <p className="text-sm text-port-warning">Finish the {formatCount(remaining)} field choices above. The preview updates automatically when every field is chosen.</p>}
        {!busy && !remaining && !ready && <button type="button" disabled={!!reason} className={buttonClass} onClick={() => makePreview()}>{error ? 'Retry preview' : 'Preview consolidation'}</button>}
        {ready && <>
          <p role="status" className="text-sm">Preview is up to date. Review the result before confirming.</p>
          <RecordValues title="Proposed survivor after consolidation" record={preview.proposed} />
          <p className="text-xs text-gray-500">{Object.entries(preview.counts || {}).map(([key, count]) => `${formatCount(count)} ${humanizeIntegrityField(key)}`).join(' · ')} preserved in the recovery receipt.</p>
          <label htmlFor="merge-confirm" className="flex gap-2 items-start text-sm"><input id="merge-confirm" type="checkbox" checked={confirmed} disabled={busy || !!reason} onChange={(event) => setConfirmed(event.target.checked)} />I confirm these are the same subject and have reviewed the proposed result.</label>
          <button type="button" className={buttonClass} disabled={busy || !!reason || !confirmed} onClick={apply}>Consolidate locally</button>
        </>}
      </div>
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
