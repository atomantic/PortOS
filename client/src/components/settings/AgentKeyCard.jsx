import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import toast from '../ui/Toast';
import { getAgentKeyStatus, setAgentKeyEnabled, rotateAgentKey } from '../../services/api';
import { formatDateShort } from '../../utils/formatters';

// The agent API key lets a Claude Code / Codex session on this computer call
// the PortOS API without the password: the server keeps a revocable session
// token in a file only this computer's user can read (server/services/agentKey.js).
export default function AgentKeyCard() {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getAgentKeyStatus({ silent: true })
      .then((res) => { if (!cancelled) setStatus(res); })
      .catch(() => { if (!cancelled) setStatus(null); });
    return () => { cancelled = true; };
  }, []);

  const run = async (action, call, successMessage) => {
    setBusy(action);
    const result = await call().catch((err) => err);
    setBusy(null);
    if (result instanceof Error) {
      toast.error(result.message || 'Agent key update failed');
      return;
    }
    setStatus(result);
    toast.success(successMessage);
  };

  if (!status) return null;

  const buttonClass = 'min-h-11 px-3 py-2 rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed';

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <h3 className="text-md font-semibold text-white flex items-center gap-2">
        <KeyRound className="w-4 h-4" /> Agent API key {status.enabled ? 'on' : 'off'}
      </h3>
      <p className="text-sm text-gray-400">
        Lets AI agents on this computer call PortOS without your password.
      </p>
      {status.enabled && (
        <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 min-w-0">
          <dt className="text-gray-500">File</dt>
          <dd className="text-gray-300 font-mono break-all">{status.path}</dd>
          {status.expiresAt && (
            <>
              <dt className="text-gray-500">Renews</dt>
              <dd className="text-gray-300">automatically, before {formatDateShort(status.expiresAt)}</dd>
            </>
          )}
        </dl>
      )}
      <div className="flex flex-wrap gap-2">
        {status.enabled ? (
          <>
            <button
              type="button"
              onClick={() => run('rotate', rotateAgentKey, 'New agent key written')}
              disabled={!!busy}
              className={`${buttonClass} bg-port-bg border border-port-border text-gray-300 hover:border-port-accent`}
            >
              {busy === 'rotate' ? 'Rotating…' : 'Rotate'}
            </button>
            <button
              type="button"
              onClick={() => run('off', () => setAgentKeyEnabled(false), 'Agent key revoked')}
              disabled={!!busy}
              className={`${buttonClass} bg-port-bg border border-port-border text-port-error hover:border-port-error`}
            >
              {busy === 'off' ? 'Revoking…' : 'Turn off and revoke'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => run('on', () => setAgentKeyEnabled(true), 'Agent key turned on')}
            disabled={!!busy}
            className={`${buttonClass} bg-port-accent text-white font-medium hover:opacity-90`}
          >
            {busy === 'on' ? 'Turning on…' : 'Turn on'}
          </button>
        )}
      </div>
    </div>
  );
}
