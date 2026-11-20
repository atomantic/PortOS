import { useCallback } from 'react';
import { AlertTriangle, Film, RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import LocalSetupPanel from '../settings/LocalSetupPanel';
import RuntimeFingerprint from './RuntimeFingerprint';
import toast from '../ui/Toast';
import { patchSettingsSlice } from '../../services/apiSystem.js';

/**
 * VideoGen's top strip: the local Python health pill with refresh, the Episode
 * and Settings entry points, the runtime fingerprint, and the in-place Python
 * setup panel when the legacy interpreter is not configured.
 */
export default function VideoGenStatusBar({ status, statusLoading, onRefresh, onOpenEpisode, onOpenSettings }) {
  const handleSavePythonPath = useCallback(async (path) => {
    await patchSettingsSlice('imageGen.local', { pythonPath: path || null }, { silent: true })
      .then(() => onRefresh())
      .catch((err) => toast.error(`Failed to save: ${err.message}`));
  }, [onRefresh]);

  return (
    <>
      <div className="flex items-center justify-between gap-2 text-xs">
        {status ? (
          <span
            className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border ${
              status.connected
                ? 'border-port-success/40 bg-port-success/10 text-port-success'
                : 'border-port-error/40 bg-port-error/10 text-port-error'
            }`}
            title={status.pythonPath || 'Local Python'}
          >
            {status.connected ? (
              <><span className="w-2 h-2 rounded-full bg-port-success shrink-0" /> {status.pythonVersion ? `Python ${status.pythonVersion}` : 'Python'}</>
            ) : (
              <>
                <AlertTriangle className="w-3 h-3 shrink-0" />
                {status.reason || 'Local Python not configured — set one up below'}
              </>
            )}
          </span>
        ) : (
          <span className="text-gray-500">Checking…</span>
        )}
        <div className="flex items-center gap-1">
          <button
            onClick={onRefresh}
            disabled={statusLoading}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
            title="Refresh status" aria-label="Refresh status"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${statusLoading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onOpenEpisode}
            className="flex items-center gap-1.5 px-2 py-1 text-gray-300 hover:text-white border border-port-border rounded hover:bg-port-border/50"
            title="Compose a multi-scene continuous-video episode"
          >
            <Film className="w-3.5 h-3.5" /> Episode
          </button>
          <button
            type="button"
            onClick={onOpenSettings}
            className="flex items-center gap-1.5 px-2 py-1 text-gray-300 hover:text-white border border-port-border rounded hover:bg-port-border/50"
            title="Video Gen settings"
          >
            <SettingsIcon className="w-3.5 h-3.5" /> Settings
          </button>
        </div>
      </div>

      <RuntimeFingerprint runtime={status?.runtime} />

      {status && status.connected === false && (() => {
        const missingCount = status.missingPackages?.length || 0;
        const hasPath = !!status.pythonPath;
        return (
          <div className="bg-port-card border border-port-border rounded-xl p-4">
            <div className="mb-3">
              <h3 className="text-sm font-medium text-gray-200">
                {hasPath ? 'Install missing Python packages' : 'Set up Local Python'}
              </h3>
              <p className="text-[11px] text-gray-500 mt-0.5">
                {hasPath
                  ? `Your Python is selected (${status.pythonPath}), but ${missingCount} required ${missingCount === 1 ? "package isn't" : "packages aren't"} installed. Click "Install" below — PortOS will pip-install them into this interpreter.`
                  : 'Pick a Python 3.10+ interpreter — PortOS auto-detects venvs and conda installs and can install missing packages directly.'}
              </p>
            </div>
            <LocalSetupPanel
              pythonPath={status.pythonPath || ''}
              onPythonPathChange={handleSavePythonPath}
              onPackagesChanged={onRefresh}
            />
          </div>
        );
      })()}
    </>
  );
}
