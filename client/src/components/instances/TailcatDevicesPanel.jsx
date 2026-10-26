import { useId, useState } from 'react';
import { approveTailcatDevice, revokeTailcatDevice, setTailcatDeviceEnforcement } from '../../services/api';
import { useTailcatServe } from './TailcatServeProvider';
import { formatCount, timeAgo } from '../../utils/formatters';

export default function TailcatDevicesPanel() {
  const { status, busy, run, error } = useTailcatServe();
  const [label, setLabel] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const id = useId();
  const enforcement = status?.enforcement;
  const enforced = enforcement?.enabled === true;
  const canApprove = label.trim() && /^nodekey:[0-9a-f]{64}$/.test(publicKey);
  const approve = async (event) => {
    event.preventDefault();
    if (!canApprove || busy) return;
    if (await run(() => approveTailcatDevice({ label, publicKey }), 'Device approved')) {
      setLabel('');
      setPublicKey('');
    }
  };
  const buttonClass = 'text-xs border border-port-border rounded px-2 py-1 disabled:opacity-50';

  return (
    <section className="mt-3 border-t border-port-border pt-3 space-y-2" aria-label="Tailcat approved devices">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-xs font-medium">Device access</h3>
        <span className="text-xs text-gray-400">{formatCount(enforcement?.approvedCount ?? 0)} approved</span>
        <button type="button" disabled={busy || !status} className={buttonClass}
          onClick={() => run(() => setTailcatDeviceEnforcement(!enforced), 'Device enforcement updated')}>
          {enforced ? 'Use capability-only access' : 'Enable device enforcement'}
        </button>
      </div>
      <p role="status" className="text-xs text-port-warning">
        {error ? 'Device enforcement status is unavailable.' : !status ? 'Loading device policy…' : !enforced ? 'Capability-only access: a copied address grants access. Approve your devices, then enable enforcement.'
          : enforcement.state === 'enforced' ? 'Only approved device keys can connect. PortOS authentication still applies.'
            : enforcement.state === 'suspended' ? 'Access suspended: no approved devices. No clients can connect.'
              : 'Device policy saved; listener enforcement is not confirmed. Check serve status and retry.'}
      </p>
      <p className="text-xs text-gray-500">Changing enforced access restarts an enabled listener and disconnects current sessions. Metadata-only edits keep sessions running. Approved devices can reconnect. Keep the server address private.</p>
      {(status?.devices ?? []).map(device => (
        <div key={device.id} className="border border-port-border rounded p-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span>{device.label}</span>
            <span className="text-gray-500">{device.revokedAt ? `Revoked ${timeAgo(device.revokedAt)}` : `Approved ${timeAgo(device.approvedAt)}`}</span>
            {!device.revokedAt && <button type="button" disabled={busy} className={buttonClass}
              onClick={() => run(() => revokeTailcatDevice(device.id), 'Device revoked; listener policy applied')}>
              Revoke {device.label}
            </button>}
          </div>
          <code className="block text-[11px] break-all text-gray-500">{device.publicKey}</code>
        </div>
      ))}
      <form onSubmit={approve} className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor={`${id}-label`} className="block text-xs text-gray-400">Device label</label>
            <input id={`${id}-label`} value={label} maxLength={100} disabled={busy}
              onChange={event => setLabel(event.target.value)}
              className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1 text-xs" />
          </div>
          <div className="min-w-0 flex-[2]">
            <label htmlFor={`${id}-key`} className="block text-xs text-gray-400">Client public key</label>
            <input id={`${id}-key`} value={publicKey} maxLength={72} disabled={busy} placeholder="nodekey:…"
              onChange={event => setPublicKey(event.target.value)} autoComplete="off" spellCheck={false}
              className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1 text-xs font-mono" />
          </div>
        </div>
        <button type="submit" disabled={busy || !canApprove} className={buttonClass}>Approve device</button>
        <p className="text-xs text-gray-500">Verify the public key privately with the device owner. Never paste a private key. Relays and discovery cannot approve devices.</p>
      </form>
    </section>
  );
}
