import { useEffect, useState } from 'react';
import { getPeerAdminSetup, savePeerAdminGrant, previewPeerAdministration } from '../../services/api';
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

  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setError('');
    getPeerAdminSetup(peer.id, { silent: true }).then(value => {
      if (active) setSetup(value);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
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
        previousGrantId: row.grant?.id ?? null, expiresInMinutes: 60,
        allowPlanning: confirmation.allow,
      }, { silent: true });
      if (mounted.current) { setSetup(value); setConfirmation(null); }
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
      Peer administration · planning only
    </button>
    {expanded && <div className="space-y-3">
      <p className="text-gray-400">Update, restart and model installation cannot execute in this version. Previews never queue work or interrupt active jobs. Execution needs the maintenance coordinator and a separate future permission.</p>
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
              onClick={() => setConfirmation({ action: row.action, allow: true })}>Review {row.active ? 'renewal' : 'grant'}</button>
            {row.grant?.allowed && <button type="button" disabled={busy}
              className="min-h-[44px] text-port-warning" onClick={() => setConfirmation({ action: row.action, allow: false })}>Revoke {LABELS[row.action]}</button>}
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
            <p className="text-port-warning">Execution unavailable: an exclusive maintenance claim and completion reconciliation are required.</p>
          </div>}
        </div>
      </>}
    </div>}
  </section>;
}

export default function PeerAdministrationPanel({ peer }) {
  // Identity changes retire outstanding UI responses and confirmation state.
  return <Controls key={`${peer.id}:${peer.instanceId}:${peer.enabled}:${peer.hasSyncSecret}`} peer={peer} />;
}
