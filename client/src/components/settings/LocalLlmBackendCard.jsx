import { ArrowRightLeft, ArrowUpCircle, Power, PowerOff, Star } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import { formatContextLength } from '../../utils/formatters';
import {
  patchSettingsSlice,
  switchLocalLlmBackend,
  upgradeLocalLlmBackend,
} from '../../services/api';

const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';

const labelForBackend = (id) => ({ ollama: 'Ollama', lmstudio: 'LM Studio' }[id] || id);

export default function LocalLlmBackendCard({
  backend, status, isDefault, busy, actionInProgress, runAction, setConfirmAction,
}) {
  const data = status?.[backend.id];
  const Icon = backend.icon;
  const other = backend.id === 'ollama' ? 'lmstudio' : 'ollama';
  const otherData = status?.[other];
  const startupService = backend.id === 'ollama' ? data?.service : null;
  const runsAtStartup = Boolean(startupService?.runAtStartup);
  // The window resident models were ACTUALLY loaded at — Ollama picks it from
  // VRAM (4K/32K/256K), and an agent harness that overruns it dies mid-task with
  // a 400. Null while nothing is resident, since Ollama hasn't committed yet.
  const runtimeContext = backend.id === 'ollama' ? data?.contextLength?.runtime ?? null : null;
  const runtimeContextLabel = formatContextLength(runtimeContext);
  const contextBelowAgentFloor = runtimeContext != null
    && runtimeContext < (data?.contextLength?.agentMinimum ?? 0);

  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Icon size={14} />
          {backend.label}
        </div>
        <div className="flex items-center gap-1.5">
          {isDefault && (
            <span
              className="text-xs px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded"
              title="PortOS routes local-LLM runs here by default. This is independent of whether the server is running — see Local Runtime Servers above."
            >
              Default
            </span>
          )}
        </div>
      </div>

      <div className="text-xs text-gray-400">
        {data?.modelCount ?? 0} model{(data?.modelCount ?? 0) === 1 ? '' : 's'} installed
        {data?.version && <> · v{data.version}</>}
        {backend.id === 'ollama' && data?.updateAvailable && data?.latestVersion && (
          <span className="text-port-warning" title={`Ollama v${data.latestVersion} is available (you have v${data.version})`}>
            {' · '}v{data.latestVersion} available
          </span>
        )}
        {backend.id === 'ollama' && data?.upstreamAheadVersion && (
          <span title="Homebrew manages this copy, so a new release can be installed once Homebrew publishes it">
            {' · '}v{data.upstreamAheadVersion} is out, waiting on Homebrew
          </span>
        )}
        {startupService?.supported && <> · {runsAtStartup ? 'runs at login' : 'startup off'}</>}
        {runtimeContextLabel && (
          <span
            className={contextBelowAgentFloor ? 'text-port-warning' : undefined}
            title={contextBelowAgentFloor
              ? `Loaded models are running at ${runtimeContextLabel} — below what an agent harness (Claude Ollama / OpenCode Ollama) usually needs. Set "Local num_ctx" on that provider in AI Providers to reload Ollama at a larger window.`
              : `Loaded models are running at ${runtimeContextLabel}`}
          >
            {' · '}{runtimeContextLabel}
          </span>
        )}
      </div>

      {data?.installed && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-port-border/50">
          {backend.id === 'ollama' && data?.updateAvailable && (
            data?.canUpgrade ? (
              <button
                onClick={() => runAction(
                  'upgrade-ollama',
                  () => upgradeLocalLlmBackend('ollama'),
                  (r) => r?.note ? `Ollama updated — ${r.note}` : `Ollama updated to v${data.latestVersion}`,
                )}
                disabled={busy}
                className={`${btnClass} bg-port-success/20 hover:bg-port-success/30 text-port-success`}
                title={`Update Ollama from v${data.version} to v${data.latestVersion} in place (${data.latestVersionSource === 'homebrew' ? 'upgrades it through Homebrew' : 'downloads the latest release'} and restarts it)`}
              >
                {actionInProgress === 'upgrade-ollama' ? <BrailleSpinner /> : <ArrowUpCircle size={12} />}
                Update to v{data.latestVersion}
              </button>
            ) : (
              <a
                href={data.downloadUrl}
                target="_blank"
                rel="noreferrer"
                className={`${btnClass} bg-port-warning/20 hover:bg-port-warning/30 text-port-warning no-underline`}
                title={`Ollama v${data.latestVersion} is available — automatic updates aren't supported on this platform`}
              >
                <ArrowUpCircle size={12} />
                Update available
              </a>
            )
          )}
          {!isDefault && (
            <button
              onClick={() => runAction(`switch-${backend.id}`, () => switchLocalLlmBackend(backend.id), `${backend.label} is now the default backend`)}
              disabled={busy}
              className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white`}
              title="Route PortOS local-LLM runs here by default — doesn't move any models or stop the other backend"
            >
              {actionInProgress === `switch-${backend.id}` ? <BrailleSpinner /> : <Star size={12} />}
              Set as Default
            </button>
          )}
          {otherData?.available && (
            <button
              onClick={() => setConfirmAction({
                type: 'migrate',
                to: backend.id,
                from: other,
                label: `Bring ${labelForBackend(other)}'s models onto ${backend.label}?`,
                detail: `Provisions the ${otherData.modelCount ?? 0} model${(otherData.modelCount ?? 0) === 1 ? '' : 's'} on ${labelForBackend(other)} onto ${backend.label} — your default backend is unchanged. Link shares each GGUF on disk (no extra space, falls back to a copy across filesystems); Copy makes an independent duplicate. Portable single-file GGUF models move with no re-download; MLX-format, sharded, or multimodal models that can't be shared/copied are re-pulled.`,
              })}
              disabled={busy}
              className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
              title={`Copy or link the models installed on ${labelForBackend(other)} onto ${backend.label}`}
            >
              <ArrowRightLeft size={12} />
              Import from {labelForBackend(other)}
            </button>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-port-border/50">
        <span className="text-xs text-gray-500">{data?.disabled ? 'PortOS will not expect this backend to be running.' : 'Show a warning when this backend is offline.'}</span>
        <button
          onClick={() => runAction(
            `toggle-disabled-${backend.id}`,
            () => patchSettingsSlice(`localLlm.${backend.id}`, { disabled: !data?.disabled }),
            data?.disabled ? `${backend.label} enabled` : `${backend.label} marked as disabled`,
          )}
          disabled={busy}
          className={`${btnClass} ${data?.disabled ? 'bg-port-border hover:bg-port-border/70 text-white' : 'bg-port-warning/20 hover:bg-port-warning/30 text-port-warning'}`}
          title={data?.disabled ? `Re-enable ${backend.label} availability warnings` : `Mark ${backend.label} as intentionally disabled`}
        >
          {actionInProgress === `toggle-disabled-${backend.id}` ? <BrailleSpinner /> : data?.disabled ? <Power size={12} /> : <PowerOff size={12} />}
          {data?.disabled ? 'Enable warnings' : 'Mark disabled'}
        </button>
      </div>
    </div>
  );
}
