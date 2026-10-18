import { useEffect, useState } from 'react';
import useAsyncAction from '../../hooks/useAsyncAction';
import useMounted from '../../hooks/useMounted';
import { getCatalogIngredientDetails } from '../../services/apiCatalog';
import { createCatalogIdentity, previewCatalogIdentity } from '../../services/apiCatalogIdentity';
import { humanizeIntegrityField } from '../../lib/characterIntegrity';
import { safeReadJsonSession, safeWriteJsonSession, safeRemoveSession } from '../../lib/safeStorage';
import CatalogIdentityEvidence, { identityButtonClass as buttonClass, identityValueText } from './CatalogIdentityEvidence';

export default function CatalogIdentityProposal({ sourceId, survivor, localOwner, disabledReason, attemptId: operationId, onInspect, onCreated, onPendingChange }) {
  const storageKey = `catalog-identity-request:${operationId}`;
  const [pendingRequest, setPendingRequest] = useState(() => {
    const stored = safeReadJsonSession(storageKey);
    return stored?.operationId === operationId && stored.sourceId === sourceId && stored.survivorId === survivor.id ? stored : null;
  });
  const [source, setSource] = useState(null);
  const [error, setError] = useState(null);
  const [choices, setChoices] = useState({});
  const [preview, setPreview] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [retry, setRetry] = useState(0);
  const mounted = useMounted();
  useEffect(() => {
    let active = true;
    getCatalogIngredientDetails(sourceId, { silent: true }).then(result => {
      if (!active) return;
      if (!result?.ingredient) throw new Error('Source record not found');
      setSource(result.ingredient); setError(null);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [sourceId, retry]);
  const reason = disabledReason || (survivor.originInstanceId !== localOwner ? 'Create the proposal on the selected canonical survivor’s owner.'
    : survivor.payload?.locked !== false ? 'The canonical survivor must already be unlocked. This workflow cannot unlock it.'
      : source && (source.id === survivor.id ? 'The selected IDs already resolve to the same identity.'
        : source.type !== survivor.type ? 'Both records must have the same type.'
          : !source.originInstanceId || source.originInstanceId === localOwner ? 'Choose a record belonging to the other owner.'
            : source.payload?.locked !== false ? 'The source must already be unlocked by its owner. This workflow cannot unlock it.' : null));
  const [run, busy] = useAsyncAction(async action => {
    setError(null); onPendingChange?.(true);
    const body = { operationId, sourceId, survivorId: survivor.id, fieldChoices: choices };
    await (async () => {
      if (action === 'preview') {
        if (pendingRequest) return;
        setPreview(null); setConfirmed(false);
        const result = await previewCatalogIdentity(body, { silent: true });
        if (!result?.plan || !result.planHash || !Array.isArray(result.conflicts)) throw new Error('The owner-verified preview is unavailable');
        if (mounted.current) setPreview(result);
      } else {
        if (!pendingRequest && (!confirmed || !preview || preview.conflicts.length)) return;
        const request = pendingRequest || { ...body, planHash: preview.planHash };
        setPendingRequest(request);
        safeWriteJsonSession(storageKey, request);
        const operation = await createCatalogIdentity(request, { silent: true });
        if (operation?.id !== operationId) throw new Error('Creation outcome is uncertain. Inspect this operation before creating another proposal.');
        safeRemoveSession(storageKey);
        if (mounted.current) onCreated(operation);
      }
    })().catch(err => {
      if (mounted.current) {
        setError(err.message); setPreview(null); setConfirmed(false);
        if (action === 'preview' || (err.status >= 400 && err.status < 500)) {
          setPendingRequest(null); safeRemoveSession(storageKey);
        }
      }
      throw err;
    }).finally(() => onPendingChange?.(false));
  });
  return <section className="space-y-3 rounded border border-port-border p-3" aria-label="Shared identity proposal">
    <h3 className="font-semibold text-sm">Keep {survivor.name} as canonical</h3>
    <p className="text-xs break-all">Survivor: {survivor.id} · Source: {sourceId}</p>
    {reason && <p role="status" className="text-port-warning">{reason}</p>}
    {error && <p role="alert" className="text-port-error">{error}</p>}
    {!source && !error && <p role="status">Loading source…</p>}
    {!source && error && <button type="button" className={buttonClass} onClick={() => setRetry(value => value + 1)}>Retry source</button>}
    <button type="button" className={buttonClass} disabled={busy || !!reason || !source || !!pendingRequest} onClick={() => run('preview')}>Preview shared identity</button>
    {pendingRequest && <div className="rounded border border-port-warning p-3 space-y-2">
      <p className="text-sm">Creation is not confirmed. Retry the exact reviewed request with the same operation ID, or inspect its receipt. Do not create a replacement while the outcome is uncertain.</p>
      <p className="text-xs break-all">{operationId}</p>
      <button type="button" className={buttonClass} disabled={busy || !!disabledReason} onClick={() => run('create')}>Retry same creation request</button>
      <button type="button" className={buttonClass} disabled={busy} onClick={() => onInspect(operationId)}>Inspect creation receipt</button>
    </div>}
    {preview && <>
      <CatalogIdentityEvidence plan={preview.plan} />
      {preview.conflicts.map(conflict => <fieldset key={conflict.path} className="border border-port-warning/40 rounded p-3 space-y-2" disabled={busy}>
        <legend className="text-xs px-1">Resolve {conflict.path.split('/').filter(Boolean).map(humanizeIntegrityField).join(' / ')}</legend>
        {['survivor', 'source'].map(side => {
          const inputId = `identity-choice-${encodeURIComponent(conflict.path)}-${side}`;
          return <div key={side} className="flex gap-2 items-start text-xs"><input id={inputId} type="radio" name={`identity-${conflict.path}`}
            checked={choices[conflict.path] === side} onChange={() => { setChoices(current => ({ ...current, [conflict.path]: side })); setConfirmed(false); }} />
          <label htmlFor={inputId} className="min-w-0"><strong>{side === 'survivor' ? 'Keep survivor value' : 'Use source value'}</strong>
            <span className="block whitespace-pre-wrap break-words">{identityValueText(conflict[side])}</span></label></div>;
        })}
      </fieldset>)}
      {preview.conflicts.length > 0 ? <p className="text-xs text-port-warning">Choose each conflict, then preview again to review the resulting canonical content.</p> : <>
        <div className="flex gap-2 items-start"><input id="identity-confirm-proposal" type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
          <label htmlFor="identity-confirm-proposal" className="text-sm">These records describe the same subject. I reviewed the survivor, owners and proposed content.</label></div>
        <button type="button" className={buttonClass} disabled={busy || !!reason || !confirmed} onClick={() => run('create')}>Create shared identity proposal</button>
        <p className="text-xs text-gray-500">Creation records the plan. Each owner must separately accept that exact plan on its own instance before commitment.</p>
      </>}
    </>}
  </section>;
}
