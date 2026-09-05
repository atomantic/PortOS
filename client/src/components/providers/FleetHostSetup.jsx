import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, HelpCircle, Server, XCircle } from 'lucide-react';
import { getFleetLlmHost, revealFleetLlmHostKey } from '../../services/apiProviders';
import { copyToClipboard } from '../../lib/clipboard';
import { useAutoRefetch } from '../../hooks/useAutoRefetch';
import RuntimeInstallModal from '../install/RuntimeInstallModal';
import Banner from '../ui/Banner';

export default function FleetHostSetup({ compact = false, onConfigured }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [installing, setInstalling] = useState(false);
  const [key, setKey] = useState('');
  const [revealing, setRevealing] = useState(false);
  const load = useCallback(() => getFleetLlmHost({ silent: true })
    .then((value) => { setStatus(value); setError(''); })
    .catch(() => setError('Could not check this machine. Retry to detect hardware and model readiness.')), []);
  useEffect(() => { load(); }, [load]);
  useAutoRefetch(load, 15000, { enabled: !compact && !installing, pollOnly: true, immediate: false });
  const completed = useCallback(() => { load(); onConfigured?.(); }, [load, onConfigured]);
  const reveal = () => {
    setRevealing(true);
    revealFleetLlmHostKey({ silent: true }).then(({ apiKey }) => setKey(apiKey))
      .catch(() => setError('Could not read the host API key. Complete host setup first.'))
      .finally(() => setRevealing(false));
  };
  const actionClass = 'inline-flex items-center justify-center min-h-[40px] px-3 py-2 rounded-lg bg-port-accent text-white text-sm disabled:opacity-50';
  const title = status?.recommendation.title || 'Recommended model host setup';
  if (compact) return (
    <section className="rounded-xl border border-port-border bg-port-card p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" aria-label="Recommended model host">
      <div className="min-w-0">
        <p className="text-sm font-medium text-white flex items-center gap-2"><Server size={16} />{title}</p>
        <p className="text-xs text-gray-400 mt-1">{status?.serving ? 'Serving · shared request queue enabled' : 'Use one dedicated model host from your other PortOS instances.'}</p>
      </div>
      <Link to="/ai/fleet?fleetStep=host" className={actionClass}>Model host setup</Link>
    </section>
  );
  return (
    <div className="space-y-4">
      <Banner tone={status?.serving ? 'success' : 'info'} icon={Server} title={title}>
        <p>{status?.recommendation.reason || 'Detecting this machine…'}</p>
        {status && <p className="mt-2 text-xs">{status.specs.platform} · {status.specs.totalMemoryGb ?? 'Unknown'} GB RAM{status.specs.cuda?.gpus?.map((gpu) => ` · ${gpu.name} (${gpu.vramGb ?? '?'} GB VRAM)`).join('')}</p>}
      </Banner>
      {error && <Banner tone="error">{error}</Banner>}
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={load} className="min-h-[40px] px-3 rounded-lg bg-port-border text-sm">Refresh host status</button>
        <Link to="/models/llms" className="min-h-[40px] px-3 py-2 text-sm text-port-accent">Manage loaded models</Link>
      </div>
      {status && (
        <>
          <ul className="space-y-2 text-sm">
            {status.checks.map((check) => {
              const Icon = check.ok === true ? CheckCircle2 : check.ok === false ? XCircle : HelpCircle;
              return <li key={check.id} className="flex gap-2"><Icon size={16} className={check.ok === true ? 'text-port-success shrink-0' : 'text-gray-400 shrink-0'} /><span>{check.label}{check.detail && <span className="block text-xs text-gray-400">{check.detail}</span>}</span></li>;
            })}
          </ul>
          {status.recommendation.supported && (
            <section className="rounded-lg border border-port-border p-3 space-y-3 text-sm">
              <p>Reserve this GPU for Qwen. Setup reuses prepared weights, fills in missing runtime settings, keeps the container loaded, and creates a local API provider. A new install can download about 30 GB.</p>
              <p className="text-xs text-gray-400">One active generation across all clients; up to 16 requests wait for at most two minutes. Disconnecting cancels the request. Requests are held in memory and are not replayed after a restart. Other GPU models must be unloaded first. Setup disables competing local providers so they do not reload automatically.</p>
              <button type="button" disabled={installing || status.setupRunning} onClick={() => setInstalling(true)} className={actionClass}>
                {status.serving ? 'Reapply recommended host setup' : 'Set up dedicated host · download if needed'}
              </button>
              <p className="text-xs text-gray-400">Docker and its GPU drivers must be installed. PortOS can start Docker Desktop, but an engine failure, driver installation or Windows restart may need an action on the host. Setup registers PortOS recovery at Windows login. Keep Docker startup with Windows enabled.</p>
            </section>
          )}
          {status.enabled && (
            <Banner tone={status.serving ? 'success' : 'warning'}>
              {status.serving ? 'Ready for client connections.' : 'Configured; model is loading or unavailable. Refresh until all checks pass.'}
              <p className="mt-1 text-xs">{status.queue.active} generating · {status.queue.queued} queued · limit {status.queue.maxActive} active / {status.queue.maxQueued} waiting</p>
            </Banner>
          )}
          <section className="space-y-3 text-sm">
            <h3 className="font-medium">Connect another PortOS instance</h3>
            <ol className="list-decimal pl-5 space-y-2">
              <li>On the other instance, open <strong>AI Providers → Model host setup → Connect client</strong>.</li>
              <li>Use the queued API endpoint below and the host key. Choose <strong>Direct API</strong> for text calls or <strong>OpenCode TUI</strong> for coding agents. The coding tools run on that client.</li>
              <li>Refresh models, then test a small request before assigning agent tasks.</li>
            </ol>
            {status.endpoint ? (
              <div className="rounded-lg bg-port-bg p-3 space-y-2">
                <p className="break-all font-mono text-xs">{status.endpoint}</p>
                <p>Model: <code>{status.model}</code></p>
                <button type="button" onClick={() => copyToClipboard(status.endpoint)} className="text-port-accent min-h-[40px]">Copy API endpoint</button>
              </div>
            ) : <Banner tone="warning">Connect Tailscale on this host to obtain its client API address.</Banner>}
            <p className="text-xs text-gray-400">Restrict this API port to your client machines with Tailscale/network rules. Use this queued endpoint for local and remote providers; direct runtime connections bypass admission control.</p>
            <button type="button" disabled={!status.hasApiKey || revealing} onClick={key ? () => setKey('') : reveal} className="min-h-[40px] px-3 rounded-lg bg-port-border disabled:opacity-50">{key ? 'Hide API key' : 'Reveal host API key'}</button>
            {key && <div className="rounded-lg bg-port-bg p-3"><code className="text-xs break-all">{key}</code><button type="button" onClick={() => copyToClipboard(key)} className="block min-h-[40px] text-port-accent">Copy API key</button></div>}
          </section>
        </>
      )}
      <RuntimeInstallModal open={installing} runtime="vllm" label="Dedicated Qwen host" title="Set up dedicated Qwen host"
        onClose={() => setInstalling(false)} onComplete={completed} streamMethod="POST"
        installUrlBase="/api/providers/fleet-host/setup" flushMs={250}
        description="Prepare missing weights (~30 GB on a fresh install), reserve the GPU and enable the shared API queue."
        doneText="Host configured. Check readiness while the model loads." />
    </div>
  );
}
