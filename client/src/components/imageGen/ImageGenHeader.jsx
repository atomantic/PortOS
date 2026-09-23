import {
  AlertTriangle,
  RefreshCw,
  Settings as SettingsIcon,
} from 'lucide-react';
import BackendChipStrip from '../media/BackendChipStrip';
import { IMAGE_GEN_MODE, IMAGE_RUNTIME_REMEDY } from '../../lib/imageGenBackends';

const CONNECTED_MODE_LABELS = {
  __proto__: null,
  [IMAGE_GEN_MODE.LOCAL]: 'mflux/local',
  [IMAGE_GEN_MODE.CODEX]: 'codex CLI',
  [IMAGE_GEN_MODE.GROK]: 'grok CLI',
  [IMAGE_GEN_MODE.AGY]: 'agy CLI',
};

export default function ImageGenHeader({ status, backends, remix, actions }) {
  return (
    <>
      <div className="flex min-w-0 flex-col gap-2 text-xs sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {status.loading ? (
            <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-port-border bg-port-card text-gray-400">
              <RefreshCw className="w-3 h-3 animate-spin shrink-0" /> Checking {status.mode}…
            </span>
          ) : status.value ? (
            <span className={`inline-flex min-w-0 max-w-full items-center gap-1.5 px-2 py-1 rounded-full border ${
              status.ready
                ? 'border-port-success/40 bg-port-success/10 text-port-success'
                : status.unknown
                  ? 'border-port-warning/40 bg-port-warning/10 text-port-warning'
                  : 'border-port-error/40 bg-port-error/10 text-port-error'
            }`}>
              {status.ready ? (
                <><span className="w-2 h-2 rounded-full bg-port-success shrink-0" /> Ready — {status.value.model || CONNECTED_MODE_LABELS[status.value.mode] || 'external SD API'}</>
              ) : (
                <>
                  <AlertTriangle className="w-3 h-3 shrink-0" />
                  {status.unknown ? 'Could not verify' : 'Unavailable'}: {status.value.reason || 'Not connected'} —
                  {status.value.remedy?.kind === IMAGE_RUNTIME_REMEDY.INSTALL_TORCH_VENV ? (
                    <button type="button" onClick={actions.onInstallRuntime} className="underline">
                      {status.value.remedy.label}
                    </button>
                  ) : (
                    <button type="button" onClick={actions.onOpenSettings} className="underline">Settings</button>
                  )}
                </>
              )}
            </span>
          ) : (
            <span className="text-gray-500">Checking…</span>
          )}
          {backends.available.length > 1 && (
            <BackendChipStrip
              availableBackends={backends.available}
              value={backends.value}
              onChange={backends.onChange}
              disabled={status.loading}
              loadingId={status.loading ? backends.value : null}
              titlePrefix="Use"
            />
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 self-start sm:self-auto">
          <button
            onClick={actions.onRefresh}
            disabled={status.loading}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
            title="Refresh status" aria-label="Refresh status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${status.loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={actions.onOpenSettings}
            className="flex items-center gap-1.5 px-2 py-1 text-gray-300 hover:text-white border border-port-border rounded hover:bg-port-border/50"
            title="Image Gen settings"
          >
            <SettingsIcon className="w-3.5 h-3.5" /> Settings
          </button>
        </div>
      </div>

      {remix.pending && (
        <p role="status" className="rounded-lg border border-port-border bg-port-card px-3 py-2 text-xs text-gray-400">
          Restoring this image’s settings — Generate is paused until they are ready.
        </p>
      )}
      {remix.state && (remix.state.status === 'error' || remix.state.status === 'missing') && (
        <div
          role="status"
          className="rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-3 text-xs text-port-warning flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
        >
          <div>
            {remix.state.failure === 'catalog'
              ? 'Couldn’t load the model or LoRA catalog, so this image’s settings were not restored.'
              : remix.state.status === 'error'
                ? 'Couldn’t load this image’s render settings.'
                : 'That image is no longer in the gallery, so its render settings could not be restored.'}
            {' '}Retry the lookup or dismiss this notice.
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <button
              type="button"
              onClick={remix.retry}
              className="whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-accent text-white text-xs font-medium hover:bg-port-accent/80"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Retry
            </button>
            <button
              type="button"
              onClick={remix.dismiss}
              className="text-gray-400 hover:text-gray-200 text-xs"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </>
  );
}
