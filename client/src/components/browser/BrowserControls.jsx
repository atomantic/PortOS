import { Play, RefreshCw, Square } from 'lucide-react';
import { launchBrowser, stopBrowser } from '../../services/apiSystem.js';

export function BrowserControls({ status, isRunning, isConnected, loading, actionLoading, handleAction, reviewRestart, setShowLogs, setShowConfig }) {
  return (
    <div className="bg-port-card border border-port-border rounded-xl p-5">
      <h3 className="text-lg font-semibold text-white mb-4">Controls</h3>
      {isRunning && !isConnected && (
        <div role="status" className="mb-4 rounded-lg border border-port-warning/30 bg-port-warning/10 p-3 text-sm">
          <p className="font-medium text-port-warning">Chrome is not reachable</p>
          <p className="mt-1 text-gray-400">
            The launcher is running, but Chrome’s control connection is unavailable. Startup can take a few seconds.
            If this persists, restart the browser below. Restart may interrupt browser tasks.
          </p>
          {status.error && <p className="mt-2 text-port-warning break-words">{status.error}</p>}
          <p className="mt-2 text-gray-400">
            If restarting does not help, open Logs for the launch error and Config to check the Chrome binary path
            and ports. On a machine without a desktop session, enable Headless mode, save, then restart.
          </p>
          <div className="mt-3 flex flex-wrap gap-3">
            <button onClick={() => setShowLogs(true)} className="text-port-accent underline">Show logs</button>
            <button onClick={() => setShowConfig(true)} className="text-port-accent underline">Edit configuration</button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {!isRunning ? (
          <button
            onClick={() => handleAction('launch', launchBrowser)}
            disabled={loading || !status || actionLoading !== null}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-success text-white rounded-lg hover:bg-port-success/80 transition-colors disabled:opacity-50"
          >
            {actionLoading === 'launch'
              ? <RefreshCw size={14} className="animate-spin" />
              : <Play size={14} />
            }
            Launch
          </button>
        ) : (
          <>
            <button
              onClick={() => handleAction('stop', stopBrowser)}
              disabled={loading || !status || actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-error text-white rounded-lg hover:bg-port-error/80 transition-colors disabled:opacity-50"
            >
              {actionLoading === 'stop'
                ? <RefreshCw size={14} className="animate-spin" />
                : <Square size={14} />
              }
              Stop
            </button>
            <button
              onClick={reviewRestart}
              disabled={loading || !status || actionLoading !== null}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-warning text-white rounded-lg hover:bg-port-warning/80 transition-colors disabled:opacity-50"
            >
              {actionLoading === 'restart'
                ? <RefreshCw size={14} className="animate-spin" />
                : <RefreshCw size={14} />
              }
              {isConnected ? 'Restart' : 'Restart browser to reconnect'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function BrowserRestartBanner({ restartPreflight, actionLoading, confirmBrowserRestart, cancelRestart }) {
  return (
    <div role="alert" className="rounded-lg border border-port-warning/30 bg-port-warning/10 p-4 text-sm text-gray-200 space-y-3">
      <p>Restarting closes browser tabs, interrupts downloads and agent connections, and may lose unsaved work.</p>
      {!restartPreflight && <p>Checking the running and installed browser versions…</p>}
      {restartPreflight?.runningVersion && restartPreflight.state !== 'configuration-mismatch' && <p>Running Chrome {restartPreflight.runningVersion}; installed {restartPreflight.installedVersion}.</p>}
      {restartPreflight?.state === 'configuration-mismatch' && <p>The connected browser differs from the configured app; the next app and version are unverified.</p>}
      {restartPreflight?.state === 'downgrade-risk' && <p>Installed Chrome is older than the running browser; update the installed app before restarting.</p>}
      {restartPreflight?.state === 'forbidden' && <p>{restartPreflight.message}</p>}
      {restartPreflight && restartPreflight.state !== 'forbidden' && !restartPreflight.ticket && <p>The browser version could not be verified. A restart may load a different or older browser.</p>}
      <div className="flex flex-wrap gap-2">
        <button onClick={confirmBrowserRestart} disabled={actionLoading !== null || !restartPreflight || restartPreflight.state === 'forbidden'}
          className="rounded-lg bg-port-warning px-3 py-1.5 text-white disabled:opacity-50">
          {!restartPreflight ? 'Checking browser…' : restartPreflight.state === 'forbidden' ? 'Restart unavailable' : !restartPreflight.ticket ? 'Restart without version verification'
            : restartPreflight.state === 'downgrade-risk' ? 'Restart with older Chrome' : 'Restart browser now'}
        </button>
        <button onClick={cancelRestart} className="rounded-lg border border-port-border px-3 py-1.5">Cancel</button>
      </div>
    </div>
  );
}
