import { useCallback, useEffect, useRef, useState } from 'react';
import useAsyncAction from '../../hooks/useAsyncAction';
import useMounted from '../../hooks/useMounted';
import { acceptCatalogIdentity, advanceCatalogIdentity, abortCatalogIdentity, recoverCatalogIdentity, getCatalogIdentity } from '../../services/apiCatalogIdentity';
import CatalogIdentityEvidence, { IdentityValues, identityButtonClass as buttonClass } from './CatalogIdentityEvidence';
import { formatDateTime } from '../../utils/formatters';

const stateLabels = {
  proposed: 'Proposed · local owner acceptance required',
  prepared: 'Accepted here · reserved while awaiting the coordinator decision',
  committed: 'Canonical identity committed here',
  aborted: 'Aborted · no canonical consolidation applied',
  recovery_prepared: 'Recovery accepted here · waiting for bilateral completion',
  recovered: 'Recovered here · original identities restored',
};

export default function CatalogIdentityOperation({ id, ingredientId, localOwner, disabledReason, version, onUpdated, onPendingChange }) {
  const [operation, setOperation] = useState(null);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);
  const [reviewed, setReviewed] = useState(false);
  const [armed, setArmed] = useState(null);
  const mounted = useMounted();
  const generation = useRef(0);
  const validate = useCallback(result => {
    if (!result?.plan || result.id !== id || ![result.sourceId, result.survivorId].includes(ingredientId)) throw new Error('This shared identity operation does not belong to the current record.');
    if (result.localOwner !== localOwner) throw new Error('This operation is not recorded for the current owner.');
    return result;
  }, [id, ingredientId, localOwner]);
  useEffect(() => {
    let active = true;
    const request = ++generation.current;
    getCatalogIdentity(id, { silent: true }).then(result => {
      if (!active || request !== generation.current) return;
      const valid = validate(result);
      setOperation(valid); setError(null); setReviewed(false); setArmed(null);
    }).catch(err => { if (active && request === generation.current) setError(err.message); });
    return () => { active = false; };
  }, [id, ingredientId, localOwner, retry, version, validate]);
  const [run, busy] = useAsyncAction(async action => {
    if (!operation || disabledReason && action !== 'abort') return;
    const request = ++generation.current;
    setError(null); onPendingChange?.(true);
    const calls = {
      accept: () => acceptCatalogIdentity(id, operation.planHash, { silent: true }),
      advance: () => advanceCatalogIdentity(id, { silent: true }),
      abort: () => abortCatalogIdentity(id, { silent: true }),
      recover: () => recoverCatalogIdentity(id, operation.planHash, { silent: true }),
    };
    await calls[action]().then(result => {
      const valid = validate(result);
      if (!mounted.current) return;
      onUpdated(valid);
      if (request !== generation.current) return;
      setOperation(valid); setReviewed(false); setArmed(null);
    }).catch(err => {
      if (mounted.current && request === generation.current) setError(err.message);
      throw err;
    }).finally(() => onPendingChange?.(false));
  });
  const coordinator = operation?.localOwner === operation?.survivorOwner;
  const canAccept = operation?.state === 'proposed';
  const canAbort = operation?.state === 'proposed' || coordinator && operation?.state === 'prepared';
  const canRecover = operation?.state === 'committed';
  const canAdvance = !!stateLabels[operation?.state];
  return <section aria-label="Shared identity operation" className="rounded border border-port-border p-3 space-y-3">
    <h3 className="font-semibold text-sm">Shared identity operation</h3>
    <p className="text-xs break-all">{id}</p>
    {error && <div role="alert" className="space-y-2 text-port-error"><p>{error}</p><p className="text-xs">The result is not confirmed. Keep this operation ID; reload its receipt before retrying. An unavailable peer does not release a prepared reservation.</p></div>}
    <button type="button" disabled={busy} className={buttonClass} onClick={() => setRetry(value => value + 1)}>Reload local receipt</button>
    {!operation && !error && <p role="status">Loading owner receipt…</p>}
    {operation && <>
      <p role="status" className="text-sm">{stateLabels[operation.state] || `Unrecognized phase: ${operation.state}`}</p>
      <p className="text-xs break-all">Local owner: {operation.localOwner} · Coordinator and canonical owner: {operation.survivorOwner}</p>
      <p className="text-xs">Receipt updated {formatDateTime(operation.updatedAt)}</p>
      <p className="text-xs">{operation.peerState
        ? `Other owner’s last verified phase: ${operation.peerState}${operation.peerObservedAt ? ` · ${formatDateTime(operation.peerObservedAt)}` : ''}`
        : 'Other owner’s phase has not been verified here.'}</p>
      {operation.state === 'committed' && <p className="text-sm text-port-warning">{operation.peerState === 'committed'
        ? 'Both owners have recorded commitment as of the last verification.'
        : 'Commitment here does not confirm adoption by the other owner. Continue with the same operation to verify or finish adoption.'}</p>}
      {operation.state === 'recovered' && operation.peerState !== 'recovered' && <p className="text-sm text-port-warning">Recovery here does not confirm recovery on the other owner. The other owner must resume this same operation.</p>}
      {disabledReason && <p className="text-port-warning text-sm">{disabledReason}</p>}
      <CatalogIdentityEvidence plan={operation.plan} />
      {operation.appliedFingerprint && <p className="text-xs break-all">Applied state receipt: {operation.appliedFingerprint}</p>}
      {operation.recovery && <IdentityValues title="Recovery receipt" value={operation.recovery} />}
      <p className="text-xs text-gray-500">Reviewed plan: <span className="break-all">{operation.planHash}</span>. Original histories and asset attribution stay available above. Only the canonical owner may edit canonical content after commitment.</p>
      {canAccept && <div className="flex items-start gap-2"><input id="identity-accept-reviewed" type="checkbox" checked={reviewed} disabled={busy || !!disabledReason} onChange={event => setReviewed(event.target.checked)} />
        <label htmlFor="identity-accept-reviewed" className="text-sm">I accept this exact reviewed plan for the record owned by this instance. This reserves it until the coordinator decides.</label></div>}
      <div className="flex flex-wrap gap-2">
        {canAccept && <button type="button" className={buttonClass} disabled={busy || !!disabledReason || !reviewed} onClick={() => run('accept')}>Accept as this owner</button>}
        {canAdvance && <button type="button" className={buttonClass} disabled={busy || !!disabledReason} onClick={() => run('advance')}>{operation.state === 'committed' && !coordinator ? 'Refresh from canonical owner' : 'Continue / verify with other owner'}</button>}
        {canAbort && <button type="button" className={buttonClass} disabled={busy} onClick={() => setArmed('abort')}>{coordinator ? 'Abort uncommitted proposal' : 'Decline unaccepted proposal'}</button>}
        {canRecover && <button type="button" className={buttonClass} disabled={busy || !!disabledReason} onClick={() => setArmed('recover')}>Review recovery</button>}
      </div>
      {armed && <div className="rounded border border-port-warning p-3 space-y-2">
        <p className="text-sm">{armed === 'abort' ? coordinator ? 'Record the coordinator’s durable abort? The other owner resumes this operation to release its reservation.' : 'Decline this proposal before accepting it? The coordinator observes the decline when resuming this operation.'
          : 'Accept recovery of this exact applied state? The coordinator must prepare first, then the other owner accepts, then both resume. Later changes block recovery; there is no force option.'}</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={buttonClass} disabled={busy || !!disabledReason && armed !== 'abort'} onClick={() => run(armed)}>{armed === 'abort' ? coordinator ? 'Confirm coordinator abort' : 'Confirm decline' : 'Accept recovery as this owner'}</button>
          <button type="button" className={buttonClass} disabled={busy} onClick={() => setArmed(null)}>Cancel</button></div>
      </div>}
    </>}
  </section>;
}
