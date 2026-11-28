import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Play } from 'lucide-react';
import { CONVERSATIONAL_GEMMA, voiceModelDisplayName } from '../../../../server/lib/voiceModelCatalog.js';
import { localEndpointPort } from '../../../../server/lib/localEndpoint.js';
import { LOCAL_RUNTIME_MANAGE_URLS, localRuntimeKind } from '../../../../server/lib/modelPinMembership.js';
import { PORTS } from '../../../../server/lib/ports.js';
import { getLlamaServerStatus, setLlamaServerAutoStart, startLlamaServer } from '../../services/apiLocalLlm';
import useMounted from '../../hooks/useMounted';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';

/** True for a provider that talks to the llama-server PortOS manages (the one this row controls). */
export function isManagedLlamaProvider(provider) {
  if (!provider) return false;
  return provider.id === CONVERSATIONAL_GEMMA.llamaProviderId
    || localRuntimeKind(provider) === 'llama'
    || Number(localEndpointPort(provider.endpoint)) === PORTS.LLAMA_SERVER;
}

/**
 * The managed llama.cpp server behind the Voice Brain, in one row: is it up,
 * Start it (replaying its last launch line), and "Start with PortOS".
 * Status is read once on mount; this row's own actions apply their responses.
 */
export default function LlamaRuntimeRow() {
  const mountedRef = useMounted();
  const [status, setStatus] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(null);

  const load = useCallback(() => {
    setLoadFailed(false);
    return getLlamaServerStatus({ silent: true })
      .then((next) => { if (mountedRef.current) setStatus(next); })
      .catch(() => { if (mountedRef.current) setLoadFailed(true); });
  }, [mountedRef]);

  useEffect(() => { load(); }, [load]);

  const run = async (key, action) => {
    if (busy) return;
    setBusy(key);
    try {
      await action();
    } catch (err) {
      if (mountedRef.current) toast.error(err.message);
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  };

  const toggleAutoStart = () => run('auto', async () => {
    try {
      const result = await setLlamaServerAutoStart(!status?.autoStart, { silent: true });
      if (!mountedRef.current) return;
      if (result?.status) setStatus(result.status);
      if (result?.started) toast.success('llama.cpp started');
    } catch (err) {
      // The server persists autoStart before attempting to start llama-server;
      // refresh status so the switch reflects the saved setting even if startup fails.
      if (mountedRef.current) {
        await getLlamaServerStatus({ silent: true })
          .then((next) => { if (mountedRef.current) setStatus(next); })
          .catch(() => {});
      }
      throw err;
    }
  });

  const start = () => run('start', async () => {
    await startLlamaServer(status.savedLaunch, { silent: true });
    if (mountedRef.current) await load();
  });

  if (loadFailed) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-port-text-muted">
        <span>Could not read llama.cpp status.</span>
        <button type="button" onClick={load} className="min-h-9 pointer-coarse:min-h-11 rounded-md border border-port-border px-2.5 text-xs text-port-accent-text hover:border-port-accent">
          Retry
        </button>
      </div>
    );
  }
  if (!status) return null;

  const manageUrl = LOCAL_RUNTIME_MANAGE_URLS.llama;
  if (!status.installed) {
    return (
      <p className="text-xs text-port-text-muted">
        llama.cpp is not installed. <Link to={manageUrl} className="font-medium text-port-accent-text underline">Set it up</Link>
      </p>
    );
  }

  const served = status.config?.alias || status.savedLaunch?.alias;
  const canStart = !status.running && Boolean(status.savedLaunch?.model);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-port-border bg-port-bg/60 px-2.5 py-2 text-xs text-port-text">
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${status.running ? 'bg-port-success' : 'bg-port-text-muted'}`} />
        <span role="status" className="min-w-0 break-words">
          llama.cpp {status.running ? 'running' : 'stopped'}{served ? ` · ${voiceModelDisplayName(served)}` : ''}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-2">
        {canStart && (
          <button
            type="button"
            onClick={start}
            disabled={Boolean(busy)}
            className="inline-flex min-h-9 pointer-coarse:min-h-11 items-center gap-1.5 rounded-md border border-port-accent/60 bg-port-card px-2.5 text-xs font-medium text-port-accent-text hover:border-port-accent disabled:opacity-50"
          >
            {busy === 'start' ? <BrailleSpinner /> : <Play size={11} aria-hidden="true" />}
            Start
          </button>
        )}
        {!status.running && !status.savedLaunch && (
          <Link to={manageUrl} className="text-port-accent-text underline">Choose a model</Link>
        )}
        <label className="inline-flex min-h-9 pointer-coarse:min-h-11 cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={Boolean(status.autoStart)}
            disabled={Boolean(busy)}
            onChange={toggleAutoStart}
            className="h-4 w-4"
          />
          {busy === 'auto' ? <BrailleSpinner /> : null}
          Start with PortOS
        </label>
      </span>
    </div>
  );
}
