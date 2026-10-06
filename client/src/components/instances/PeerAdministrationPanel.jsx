import { useEffect, useRef, useState } from 'react';
import { getPeerAdminSetup, savePeerAdminGrant, previewPeerAdministration, savePeerExecutionGrant, previewPeerExecution, dispatchPeerExecution, getPeerExecutionStatus } from '../../services/api';
import { safeReadJsonStorage, safeWriteJsonStorage, safeReadStorage } from '../../lib/safeStorage';
import socket from '../../services/socket';
import PeerCatalogControls from './PeerCatalogControls';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import useMounted from '../../hooks/useMounted';
import { timeUntil } from '../../utils/formatters';

const LABELS = {
  'portos.update': 'PortOS update',
  'portos.restart': 'PortOS restart',
  'catalog.install': 'Catalog model installation',
};

function Controls({ peer }) {
  const [expanded, setExpanded] = useState(false);
  const [setup, setSetup] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmation, setConfirmation] = useState(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const mounted = useMounted();
  const setupGeneration = useRef(0);
  const updateSetup = value => {
    setupGeneration.current += 1;
    setSetup(value);
  };

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    const refresh = () => {
      const generation = ++setupGeneration.current;
      getPeerAdminSetup(peer.id, { silent: true }).then(value => {
        if (active && generation === setupGeneration.current) setSetup(value);
      }).catch(err => { if (active && generation === setupGeneration.current) setError(err.message); });
    };
    setError('');
    refresh();
    socket.on('peer-execution:changed', refresh);
    socket.on('connect', refresh);
    return () => {
      active = false;
      socket.off('peer-execution:changed', refresh);
      socket.off('connect', refresh);
    };
  }, [expanded, peer.id]);

  const save = async () => {
    if (busy || !confirmation || !setup) return;
    setBusy(true);
    setError('');
    const row = setup.actions.find(entry => entry.action === confirmation.action);
    try {
      const value = await savePeerAdminGrant({
        peerId: peer.id, action: row.action,
        confirmedHostInstanceId: setup.hostInstanceId, confirmedPeerInstanceId: setup.peerInstanceId,
        previousGrantId: confirmation.grantId, expiresInMinutes: 60,
        allowPlanning: confirmation.allow,
      }, { silent: true });
      if (mounted.current) { updateSetup(value); setConfirmation(null); }
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setBusy(false); }
  };

  const inspect = async action => {
    if (busy) return;
    setBusy(true);
    setError('');
    setPreview(null);
    try {
      const value = await previewPeerAdministration({ peerId: peer.id, intent: { action } }, { silent: true });
      if (mounted.current) setPreview(value);
    } catch (err) { if (mounted.current) setError(err.message); }
    finally { if (mounted.current) setBusy(false); }
  };

  return <section className="border-t border-port-border pt-3 mt-3 text-sm">
    <button type="button" aria-expanded={expanded} disabled={busy}
      className="min-h-[44px] text-port-accent" onClick={() => { setExpanded(value => !value); setSetup(null); setConfirmation(null); }}>
      Peer administration
    </button>
    {expanded && <div className="space-y-3">
      <p className="text-gray-400">Planning previews never queue work or interrupt active jobs. Execution requires a separate local permission on the receiving host.</p>
      {error && <p role="alert" className="text-port-error">{error}</p>}
      {setup && <>
        <p className="font-medium">Allow this peer to plan actions on this host</p>
        <dl className="text-xs text-gray-400 break-all">
          <dt>Receiving host identity</dt><dd>{setup.hostInstanceId || 'Not initialized'}</dd>
          <dt>Paired caller identity</dt><dd>{setup.peerInstanceId || 'Not paired'}</dd>
        </dl>
        {!setup.paired && <p className="text-port-warning">Enable and pair this peer locally before granting planning access.</p>}
        {setup.actions.map(row => <div key={row.action} className="flex flex-wrap items-center justify-between gap-2">
          <span>{LABELS[row.action]} — {row.active ? `Planning allowed · expires ${timeUntil(row.grant.expiresAt)}` : 'Denied'}</span>
          <div className="flex gap-2">
            <button type="button" disabled={busy || !setup.paired}
              className="min-h-[44px] text-port-accent disabled:opacity-50"
              onClick={() => setConfirmation({ action: row.action, allow: true, grantId: row.grant?.id ?? null })}>Review {row.active ? 'renewal' : 'grant'}</button>
            {row.grant?.allowed && <button type="button" disabled={busy}
              className="min-h-[44px] text-port-warning" onClick={() => setConfirmation({ action: row.action, allow: false, grantId: row.grant?.id ?? null })}>Revoke {LABELS[row.action]}</button>}
          </div>
        </div>)}
        {confirmation && <div className="rounded border border-port-border p-3 space-y-2">
          <p>{confirmation.allow ? 'Allow' : 'Revoke'} {LABELS[confirmation.action]} planning for the exact paired identity above on this host{confirmation.allow ? ' for one hour' : ''}. This does not authorize execution, accept model licenses, or install software.</p>
          <ConfirmButtonPair tone="warning" confirmText={confirmation.allow ? 'Allow planning for one hour' : 'Confirm revocation'}
            onConfirm={save} onCancel={() => setConfirmation(null)} busy={busy} />
        </div>}
        <div className="border-t border-port-border pt-3 space-y-2">
          <p className="font-medium">Preview requirements on the remote peer</p>
          <p className="text-gray-400">The receiving peer needs its own local planning grant for this host. A preview creates a short-lived plan receipt; it starts nothing.</p>
          <div className="flex flex-wrap gap-3">
            {['portos.update', 'portos.restart'].map(action => <button key={action} type="button" disabled={busy || !setup.paired}
              className="min-h-[44px] text-port-accent disabled:opacity-50" onClick={() => inspect(action)}>Preview {LABELS[action]}</button>)}
          </div>
          <p className="text-xs text-gray-400">Catalog install plans are API-only while the local source, license and destination checks are being integrated.</p>
          {preview && <div role="status" className="rounded bg-port-bg p-3 space-y-1 break-all">
            <p>Planned only · not queued · not in flight</p>
            <p>Request: {preview.plan.requestId}</p>
            <p>Verified peer version: {preview.preflight.version}</p>
            <p className="text-port-warning">This planning receipt cannot authorize execution. Use a separate execution preview below.</p>
          </div>}
        </div>
        {setup.execution && <ExecutionControls peer={peer} setup={setup} onSetup={updateSetup} />}
      </>}
    </div>}
  </section>;
}

function ExecutionControls({ peer, setup, onSetup }) {
  const execution = setup.execution;
  const [confirmation, setConfirmation] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const storageKey = `peer-execution:${setup.hostInstanceId}:${peer.id}:${setup.peerInstanceId}`;
  const [request, setRequest] = useState(() => {
    const saved = safeReadJsonStorage(storageKey);
    return typeof saved?.requestId === 'string' ? saved : null;
  });
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState('');
  const mounted = useMounted();
  const unresolved = request && !['succeeded', 'failed'].includes(request.state);
  const remember = (value, requireDurable = false) => {
    safeWriteJsonStorage(storageKey, value);
    if (requireDurable && safeReadStorage(storageKey) !== JSON.stringify(value)) {
      throw new Error('Execution was not submitted because this browser could not save its recovery record. Enable persistent browser storage and prepare the action again.');
    }
    if (mounted.current) setRequest(value);
  };
  const run = async work => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    await work().catch(err => { if (mounted.current) setError(err.message); });
    busyRef.current = false;
    if (mounted.current) setBusy(false);
  };
  const saveGrant = () => run(async () => {
    const row = execution.actions.find(entry => entry.action === confirmation.action);
    const value = await savePeerExecutionGrant({
      peerId: peer.id, action: row.action,
      confirmedHostInstanceId: setup.hostInstanceId, confirmedPeerInstanceId: setup.peerInstanceId,
      previousGrantId: confirmation.grantId, expiresInMinutes: 60,
      allowExecution: confirmation.allow, confirmation: 'execution-v1',
    }, { silent: true });
    if (mounted.current) { onSetup(value); setConfirmation(null); }
  });
  const prepare = intent => run(async () => {
    setPreflight(null);
    const value = await previewPeerExecution({ peerId: peer.id, intent }, { silent: true });
    if (mounted.current) setPreflight(value);
  });
  const dispatch = () => run(async () => {
    // Verify persistent storage BEFORE launch so recovery survives reloads and tab closure.
    const pending = { requestId: preflight.payload.requestId, state: 'uncertain' };
    remember(pending, true);
    const envelope = preflight;
    setPreflight(null);
    const value = await dispatchPeerExecution({ peerId: peer.id, preflight: envelope }, { silent: true });
    remember(value);
  });
  const checkStatus = () => run(async () => {
    const value = await getPeerExecutionStatus({ peerId: peer.id, requestId: request.requestId }, { silent: true });
    if (!Number.isSafeInteger(request.revision) || value.revision >= request.revision) remember(value);
  });

  return <div className="border-t border-port-border pt-3 space-y-3">
    <p className="font-medium">Allow this peer to execute on this host</p>
    <p className="text-gray-400">Execution permission is separate from planning and applies only to the receiving host and paired caller identities above. Each action is denied until explicitly granted here. Active work must drain before maintenance can run.</p>
    {execution.actions.map(row => <div key={row.action} className="flex flex-wrap items-center justify-between gap-2">
      <span>{LABELS[row.action]} — {row.active ? `Execution allowed · expires ${timeUntil(row.grant.expiresAt)}` : 'Execution denied'}</span>
      <div className="flex gap-2">
        <button type="button" disabled={busy || !setup.paired} className="min-h-[44px] text-port-accent disabled:opacity-50"
          onClick={() => setConfirmation({ action: row.action, allow: true, grantId: row.grant?.id ?? null })}>Review execution {row.active ? 'renewal' : 'grant'} for {LABELS[row.action]}</button>
        {row.grant?.allowed && <button type="button" disabled={busy} className="min-h-[44px] text-port-warning"
          onClick={() => setConfirmation({ action: row.action, allow: false, grantId: row.grant?.id ?? null })}>Revoke execution for {LABELS[row.action]}</button>}
      </div>
    </div>)}
    {confirmation && <div className="rounded border border-port-border p-3 space-y-2">
      <p>{confirmation.allow ? 'Allow' : 'Revoke'} {LABELS[confirmation.action]} execution by paired caller {setup.peerInstanceId} on receiving host {setup.hostInstanceId}{confirmation.allow ? ' for one hour' : ''}. This permission does not accept model licenses or start work by itself.</p>
      <ConfirmButtonPair tone="warning" confirmText={confirmation.allow ? 'Allow execution for one hour' : 'Confirm execution revocation'}
        onConfirm={saveGrant} onCancel={() => setConfirmation(null)} busy={busy} />
    </div>}
    <p className="font-medium">Execute on the remote peer</p>
    <p className="text-gray-400">The remote peer must separately grant this host the selected action. Review a fresh signed preview before submitting work.</p>
    {error && <p role="alert" className="text-port-error">{error}</p>}
    <div className="flex flex-wrap gap-3">
      {['portos.update', 'portos.restart'].map(action => <button key={action} type="button" disabled={busy || !setup.paired || unresolved}
        className="min-h-[44px] text-port-accent disabled:opacity-50" onClick={() => prepare({ action })}>Prepare {LABELS[action]} execution</button>)}
    </div>
    <PeerCatalogControls hostInstanceId={setup.hostInstanceId} disabled={busy || !setup.paired || Boolean(unresolved)} onPrepare={prepare} />
    {preflight && <div className="rounded border border-port-border p-3 space-y-2 break-all">
      <p>{LABELS[preflight.payload.intent.action]} on {preflight.payload.targetInstanceId}</p>
      {preflight.payload.intent.catalogKey && <p>Catalog entry: {preflight.payload.intent.catalogKey} · {preflight.payload.intent.backend}</p>}
      <p>Verified peer version: {preflight.payload.version} · Preview expires {timeUntil(preflight.payload.expiresAt)}</p>
      <p>Request: {preflight.payload.requestId}</p>
      <ConfirmButtonPair tone="warning" confirmText="Submit execution" onConfirm={dispatch} onCancel={() => setPreflight(null)} busy={busy} />
    </div>}
    {request && <div role="status" className="rounded bg-port-bg p-3 space-y-2 break-all">
      <p>Execution status: {request.state}</p><p>Request: {request.requestId}</p>
      {request.code && <p>{request.code}</p>}
      {unresolved && <p className="text-port-warning">Keep this request ID. Check status after reconnecting; an unavailable response does not mean the operation failed. Do not submit the action again.</p>}
      <button type="button" disabled={busy} className="min-h-[44px] text-port-accent disabled:opacity-50" onClick={checkStatus}>Check execution status</button>
    </div>}
  </div>;
}

export default function PeerAdministrationPanel({ peer }) {
  // Identity changes retire outstanding UI responses and confirmation state.
  return <Controls key={`${peer.id}:${peer.instanceId}:${peer.enabled}:${peer.hasSyncSecret}`} peer={peer} />;
}
