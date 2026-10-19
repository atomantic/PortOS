import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import CollapsibleSection from '../ui/CollapsibleSection';
import InfiniteScrollFooter from '../ui/InfiniteScrollFooter';
import { usePagedCollection } from '../../hooks/usePagedCollection';
import useAsyncAction from '../../hooks/useAsyncAction';
import useMounted from '../../hooks/useMounted';
import socket from '../../services/socket';
import { getSelfInstance } from '../../services/apiSystem';
import { listCatalogIngredients } from '../../services/apiCatalog';
import { importCatalogIdentity, listCatalogIdentities } from '../../services/apiCatalogIdentity';
import CatalogIdentityProposal from './CatalogIdentityProposal';
import CatalogIdentityOperation from './CatalogIdentityOperation';
import { identityButtonClass as buttonClass } from './CatalogIdentityEvidence';
import { formatDateTime } from '../../utils/formatters';
import { uuidv4 } from '../../lib/uuid';

export default function CatalogIdentityPanel(props) {
  const [params] = useSearchParams();
  return <CollapsibleSection label="Shared canonical identity" size="bar" defaultOpen={params.has('identitySource') || params.has('identityOperation')}
    className="bg-port-card border border-port-border rounded-lg p-4" bodyClassName="pt-3">
    <IdentityManager key={props.record.id} {...props} />
  </CollapsibleSection>;
}

function IdentityManager({ record, disabledReason, onChanged, onPendingChange }) {
  const [params, setParams] = useSearchParams();
  const sourceId = params.get('identitySource') || '';
  const selectedSurvivor = params.get('identitySurvivor') || record.id;
  const operationId = params.get('identityOperation') || '';
  const attemptId = params.get('identityAttempt') || '';
  const [self, setSelf] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [version, setVersion] = useState(0);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [peerDraft, setPeerDraft] = useState(params.get('identityPeer') || '');
  const [operationDraft, setOperationDraft] = useState('');
  const [importError, setImportError] = useState(null);
  const mounted = useMounted();
  useEffect(() => {
    if (!sourceId || attemptId || operationId) return;
    setParams(current => {
      const next = new URLSearchParams(current);
      if (!next.has('identityAttempt')) next.set('identityAttempt', uuidv4());
      return next;
    }, { replace: true });
  }, [sourceId, attemptId, operationId, setParams]);
  useEffect(() => {
    let active = true;
    getSelfInstance({ silent: true }).then(result => {
      if (!active) return;
      if (!result?.instanceId || result.instanceId === 'unknown') throw new Error('Current owner identity is unavailable');
      setSelf(result); setLoadError(null);
    }).catch(err => { if (active) setLoadError(err.message); });
    return () => { active = false; };
  }, [record.id, version]);
  const fetchHistory = useCallback(async ({ cursor, signal }) => {
    const page = await listCatalogIdentities({ ingredientId: record.id, limit: 10, offset: cursor || 0, signal, silent: true });
    if (!Array.isArray(page?.items)) throw new Error('Shared identity history is unavailable');
    return { items: page.items, nextCursor: page.nextOffset };
  }, [record.id]);
  const history = usePagedCollection(fetchHistory);
  const { refreshFirst } = history;
  useEffect(() => {
    const reload = () => { setVersion(value => value + 1); refreshFirst(); };
    const changed = event => {
      if (event?.operationId === operationId || [event?.sourceId, event?.survivorId].includes(record.id)) reload();
    };
    socket.on('catalog:identity-changed', changed);
    socket.on('connect', reload);
    return () => { socket.off('catalog:identity-changed', changed); socket.off('connect', reload); };
  }, [operationId, record.id, refreshFirst]);
  const select = (values) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    setParams(next);
  };
  const update = operation => {
    history.setItems(items => [operation, ...items.filter(item => item.id !== operation.id)]);
    // Aborting changes only the agreement, so preserve a pre-existing creative
    // draft. The detail page's socket listener refreshes its ownership fence.
    if (operation.state !== 'aborted') onChanged?.();
  };
  const [importOperation, importing] = useAsyncAction(async () => {
    if (!peerDraft.trim() || !operationDraft.trim() || disabledReason) return;
    setImportError(null); onPendingChange?.(true);
    await importCatalogIdentity({ peerId: peerDraft.trim(), operationId: operationDraft.trim() }, { silent: true }).then(operation => {
      if (!operation?.id || ![operation.sourceId, operation.survivorId].includes(record.id)) throw new Error('Imported operation is not for this record. Its receipt remains available in catalog identity history.');
      if (!mounted.current) return;
      history.setItems(items => [operation, ...items.filter(item => item.id !== operation.id)]);
      select({ identityPeer: peerDraft.trim(), identityOperation: operation.id });
    }).catch(err => { if (mounted.current) setImportError(err.message); throw err; })
      .finally(() => onPendingChange?.(false));
  });
  const createReason = disabledReason || (selectedSurvivor !== record.id ? 'The survivor in this link does not match the current record. Clear the selection and select the intended survivor.'
    : self && record.originInstanceId !== self.instanceId ? 'Create a proposal on the canonical survivor’s owner. This owner can import a proposal and accept its own source record.'
      : record.payload?.locked !== false ? 'This record must already be unlocked before proposing a shared identity.' : null);
  return <div className="space-y-4 text-gray-300">
    <p className="text-sm">Consolidate the same subject across two owners. The selected survivor retains its ID and owner. Each owner accepts the exact plan locally; originals, histories and assets remain attributed and recoverable.</p>
    <p className="text-xs text-gray-500">Both records must already be unlocked. This workflow never unlocks records. An offline peer leaves the operation pending; use the same operation ID to resume.</p>
    {loadError && <p role="alert">{loadError}</p>}
    {!self && <button type="button" className={buttonClass} onClick={() => setVersion(value => value + 1)}>Reload owner identity</button>}
    {self && <>
      {!operationId && <>
        {createReason && <p role="status" className="text-port-warning">{createReason}</p>}
        {!createReason && <CandidateSearch record={record} localOwner={self.instanceId} sourceId={sourceId} query={query} setQuery={setQuery} search={search} setSearch={setSearch}
          onSelect={id => select({ identitySource: id, identitySurvivor: record.id, identityAttempt: sourceId === id && params.get('identityAttempt') || uuidv4() })} />}
        {sourceId && <>
          <button type="button" className={buttonClass} onClick={() => select({ identitySource: null, identitySurvivor: null, identityAttempt: null })}>Clear shared identity selection</button>
          {attemptId && <CatalogIdentityProposal key={`${sourceId}:${selectedSurvivor}:${attemptId}`} sourceId={sourceId} survivor={record} localOwner={self.instanceId}
            attemptId={attemptId}
            onInspect={id => select({ identityOperation: id })}
            disabledReason={createReason} onPendingChange={onPendingChange}
            onCreated={operation => { history.setItems(items => [operation, ...items]); select({ identityOperation: operation.id, identitySource: null, identitySurvivor: null, identityAttempt: null }); }} />}
        </>}
      </>}
      <form className="rounded border border-port-border p-3 space-y-3" onSubmit={event => { event.preventDefault(); importOperation(); }}>
        <h3 className="font-semibold text-sm">Import a coordinator’s proposal</h3>
        <p className="text-xs">On the source owner, enter the coordinator’s instance ID and operation ID. Import verifies the plan; it does not accept it.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="min-w-0"><label htmlFor="identity-import-peer" className="block text-xs mb-1">Coordinator instance ID</label><input id="identity-import-peer" className="w-full bg-port-bg rounded border border-port-border p-2" value={peerDraft} onChange={event => setPeerDraft(event.target.value)} disabled={importing} /></div>
          <div className="min-w-0"><label htmlFor="identity-import-operation" className="block text-xs mb-1">Operation ID</label><input id="identity-import-operation" className="w-full bg-port-bg rounded border border-port-border p-2" value={operationDraft} onChange={event => setOperationDraft(event.target.value)} disabled={importing} /></div>
        </div>
        <button type="submit" className={buttonClass} disabled={importing || !!disabledReason || !peerDraft.trim() || !operationDraft.trim()}>Import verified proposal</button>
        {importError && <p role="alert" className="text-port-error">{importError}</p>}
      </form>
      {operationId && <>
        <button type="button" className={buttonClass} onClick={() => select({ identityOperation: null })}>Close selected operation</button>
        <CatalogIdentityOperation key={operationId} id={operationId} ingredientId={record.id} localOwner={self.instanceId} disabledReason={disabledReason}
          version={version} onUpdated={update} onPendingChange={onPendingChange} />
      </>}
    </>}
    <section aria-label="Shared identity history" className="space-y-2">
      <h3 className="text-sm font-semibold">Shared identity history</h3>
      {history.loaded && !history.items.length && <p className="text-xs">No shared identity operations recorded for this ingredient.</p>}
      {history.items.map(operation => <div key={operation.id} className="min-w-0 rounded border border-port-border p-3">
        <p className="text-xs break-all">{operation.sourceId} → {operation.survivorId}</p>
        <p className="text-xs">{operation.state} · {formatDateTime(operation.updatedAt || operation.createdAt)}</p>
        <button type="button" className={buttonClass} onClick={() => select({ identityOperation: operation.id })}>Inspect operation {operation.id}</button>
      </div>)}
      <InfiniteScrollFooter hasMore={history.hasMore} loading={history.loading} error={history.error} onLoadMore={history.loadMore} autoLoad={false} label="Load more identity operations" />
    </section>
  </div>;
}

function CandidateSearch({ record, localOwner, sourceId, query, setQuery, search, setSearch, onSelect }) {
  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const offset = cursor || 0;
    const page = await listCatalogIngredients({ type: record.type, q: search, limit: 24, offset, signal, silent: true });
    if (!Array.isArray(page?.items)) throw new Error('Shared identity candidate search is unavailable');
    return { items: page.items, nextCursor: page.items.length === 24 ? offset + page.items.length : null };
  }, [record.type, search]);
  const candidates = usePagedCollection(fetchPage);
  const eligible = candidates.items.filter(item => item.id !== record.id && item.type === record.type && item.originInstanceId && item.originInstanceId !== localOwner && item.payload?.locked === false);
  return <div className="space-y-2">
    <form className="flex flex-wrap gap-2 items-end" onSubmit={event => { event.preventDefault(); setSearch(query.trim()); }}>
      <div className="min-w-0 flex-1"><label htmlFor="identity-candidate-search" className="block text-xs mb-1">Find the other owner’s {record.type}</label>
        <input id="identity-candidate-search" value={query} onChange={event => setQuery(event.target.value)} className="w-full bg-port-bg rounded border border-port-border p-2" /></div>
      <button type="submit" className={buttonClass}>Search shared identity candidates</button>
    </form>
    {eligible.map(item => <div key={item.id} className="rounded border border-port-border p-3 flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0"><p className="text-sm">{item.name}</p><p className="text-xs break-all">{item.id} · Owner: {item.originInstanceId}</p></div>
      <button type="button" className={buttonClass} aria-pressed={sourceId === item.id} onClick={() => onSelect(item.id)}>Select source {item.name}</button>
    </div>)}
    {candidates.loaded && !eligible.length && <p className="text-xs">No eligible foreign-owned unlocked records in the loaded results. Search or load more.</p>}
    <InfiniteScrollFooter hasMore={candidates.hasMore} loading={candidates.loading} error={candidates.error} onLoadMore={candidates.loadMore} autoLoad={false} label="Load more identity candidates" />
  </div>;
}
