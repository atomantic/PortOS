import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Download, XCircle, Check, Loader, AlertTriangle, Trash2, ExternalLink, Tag, GitFork, GitBranch } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import Banner from '../../ui/Banner';
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import { formatDateTime } from '../../../utils/formatters';
import { useAutoRefetch } from '../../../hooks/useAutoRefetch';

const STEP_LABELS = {
  starting: 'Starting update',
  'git-pull': 'Pulling latest changes',
  'pm2-stop': 'Stopping apps',
  'npm-install': 'Installing dependencies',
  setup: 'Running setup',
  ffmpeg: 'Checking ffmpeg',
  migrations: 'Running migrations',
  build: 'Building client',
  restart: 'Restarting PortOS',
  restarting: 'Restarting PortOS',
  complete: 'Complete'
};

function StepIndicator({ status }) {
  if (status === 'running') return <Loader size={14} className="text-port-accent animate-spin" />;
  if (status === 'done') return <Check size={14} className="text-port-success" />;
  if (status === 'error') return <XCircle size={14} className="text-port-error" />;
  return <span className="w-3.5 h-3.5 rounded-full border border-gray-600 inline-block" />;
}

export default function UpdateTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [steps, setSteps] = useState([]);
  const [updateError, setUpdateError] = useState(null);
  const [polling, setPolling] = useState(false);
  const [syncingFork, setSyncingFork] = useState(false);
  const [forkSyncError, setForkSyncError] = useState(null);
  const attemptsRef = useRef(0);
  const targetVersionRef = useRef(null);
  const preUpdateVersionRef = useRef(null);
  // Mirrors `updating` for the socket 'disconnect' listener below, which is
  // registered once on mount and would otherwise close over a stale `false`.
  const updatingRef = useRef(false);
  // Tracks whether the health endpoint went down during a restart poll. A
  // reconcile (issue #1779) often lands the SAME version (new commits, no
  // release bump), so version-change detection alone can't confirm completion —
  // a down→up transition does.
  const healthWentDownRef = useRef(false);
  // Highest /system/health uptime seen so far. The server's uptime resets to
  // ~0 on restart, so an uptime that drops well below the previous peak proves
  // a restart happened — catching a same-version reconcile whose restart is too
  // fast for the 2s poll to ever sample the down window.
  const maxUptimeRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    const data = await api.getUpdateStatus().catch(() => null);
    if (data) setStatus(data);
    setLoading(false);
    return data;
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    updatingRef.current = updating;
  }, [updating]);

  // Socket event listeners for update progress
  useEffect(() => {
    // Shared by the 'restart' step, 'portos:update:complete', and the
    // 'disconnect' fallback below — all three mean "the server is (or is
    // about to be) restarting, stop trusting the socket and start polling."
    const armRestartPolling = () => {
      setUpdating(false);
      setPolling(true);
      toast.loading('PortOS is restarting...', { id: 'portos-update-restart', duration: Infinity });
    };

    const handleStep = ({ step, status: stepStatus, message }) => {
      setSteps(prev => {
        const existing = prev.findIndex(s => s.step === step);
        const entry = { step, status: stepStatus, message, timestamp: Date.now() };
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = entry;
          return updated;
        }
        return [...prev, entry];
      });
      // When the server signals it's restarting, begin health polling immediately.
      // The PM2 restart may kill the server before portos:update:complete fires.
      if ((step === 'restarting' || step === 'restart') && stepStatus !== 'error' && targetVersionRef.current) {
        armRestartPolling();
      }
    };

    const handleComplete = ({ success, newVersion, versionKnown }) => {
      if (!success) {
        setUpdating(false);
        return;
      }
      // Use server-reported actual version when available; fall back to target
      if (versionKnown && newVersion) {
        targetVersionRef.current = newVersion;
      }
      armRestartPolling();
    };

    const handleError = ({ message }) => {
      setUpdating(false);
      setPolling(false);
      toast.dismiss('portos-update-restart');
      setUpdateError(message);
    };

    // `pm2 delete ecosystem.config.cjs` (the update's own "pm2-stop" step) kills
    // this server process — and its socket — well before update.sh reaches its
    // 'restart' step. That step event, and 'portos:update:complete', are then
    // never emitted, and the UI hangs on "Reconciling..."/"Stopping apps"
    // forever even though update.sh finishes fine in the background. The
    // socket disconnecting IS the server dying, so treat it as the same
    // signal 'restart' would have been — it's a strictly more reliable proxy
    // for "the update just tore down this process" than waiting on a step
    // event from the process being torn down.
    const handleDisconnect = () => {
      if (!updatingRef.current) return;
      armRestartPolling();
    };

    socket.on('portos:update:step', handleStep);
    socket.on('portos:update:complete', handleComplete);
    socket.on('portos:update:error', handleError);
    socket.on('disconnect', handleDisconnect);

    return () => {
      socket.off('portos:update:step', handleStep);
      socket.off('portos:update:complete', handleComplete);
      socket.off('portos:update:error', handleError);
      socket.off('disconnect', handleDisconnect);
    };
  }, []);

  // Poll health endpoint after restart to detect new version. The hook's
  // `enabled: polling` gate handles teardown automatically when polling flips
  // off; attemptsRef resets on every fresh polling cycle.
  useEffect(() => {
    if (polling) {
      attemptsRef.current = 0;
      healthWentDownRef.current = false;
    }
  }, [polling]);

  const pollHealth = useCallback(async () => {
    attemptsRef.current += 1;
    const ok = await api.checkHealth().catch(() => null);
    const preUpdateVersion = preUpdateVersionRef.current;
    if (!ok) {
      // Server is mid-restart (PM2 stopped it) — record the dip so a same-version
      // recovery still counts as "restarted".
      healthWentDownRef.current = true;
    } else if (preUpdateVersion && ok.version && ok.version !== preUpdateVersion) {
      // The running version differs from before the update — restart confirmed.
      // (We don't gate on === targetVersion: that clause would fire on the FIRST
      // healthy poll of a same-version reconcile, where target === preUpdate, and
      // declare success before the server ever went down.)
      setPolling(false);
      toast.success(`Updated to v${ok.version}`, { id: 'portos-update-restart' });
      setTimeout(() => window.location.reload(), 1000);
      return;
    } else if (
      ok.version &&
      (healthWentDownRef.current ||
        (typeof ok.uptime === 'number' && ok.uptime < maxUptimeRef.current - 5))
    ) {
      // Same version, but the restart is proven either by a down→up dip or by
      // the server's uptime resetting below its pre-restart peak (the 5s slack
      // absorbs clock jitter). Catches a reconcile whose restart was too fast
      // for the 2s poll to ever sample the down window.
      setPolling(false);
      toast.success('Install reconciled — reloading', { id: 'portos-update-restart' });
      setTimeout(() => window.location.reload(), 1000);
      return;
    }
    // Track the running peak so a later uptime drop is detectable. Guard on
    // `ok` — the !ok (server-down) branch falls through to here, and a null
    // deref would throw before the attempts>=30 timeout check below, hanging the
    // UI on a restart that never recovers.
    if (ok && typeof ok.uptime === 'number' && ok.uptime > maxUptimeRef.current) {
      maxUptimeRef.current = ok.uptime;
    }
    if (attemptsRef.current >= 30) {
      setPolling(false);
      toast.error('Restart timed out — try reloading manually', { id: 'portos-update-restart' });
    }
  }, []);

  useAutoRefetch(pollHealth, 2000, { enabled: polling, pollOnly: true });

  const handleCheck = async () => {
    setChecking(true);
    const result = await api.checkForUpdate().catch(() => null);
    if (result) setStatus(prev => ({ ...(prev ?? {}), ...result }));
    setChecking(false);
  };

  // `fromStatus` lets callers (e.g. handleSyncForkAndUpdate) pass the freshly
  // fetched status object instead of relying on the closure capture — `setStatus`
  // only schedules a render and the awaited fetchStatus() return value is the
  // single source of truth for the just-loaded state.
  const runUpdate = useCallback(async (opts = {}, fromStatus = null) => {
    const s = fromStatus || status;
    if (s?.latestRelease?.version) {
      targetVersionRef.current = s.latestRelease.version;
    }
    preUpdateVersionRef.current = s?.currentVersion || null;
    // Seed the uptime peak with the still-running server's uptime, so even an
    // instant restart (whose first post-restart poll already reports a small
    // uptime) is detected as a drop below this pre-update value.
    const preHealth = await api.checkHealth().catch(() => null);
    maxUptimeRef.current = typeof preHealth?.uptime === 'number' ? preHealth.uptime : 0;
    setUpdating(true);
    setSteps([]);
    setUpdateError(null);
    const result = await api.executePortosUpdate(opts).catch(err => {
      setUpdateError(err.message);
      setUpdating(false);
      return null;
    });
    if (result?.tag) {
      targetVersionRef.current = result.tag.replace(/^v/, '');
    }
    return result;
  }, [status]);

  const handleUpdate = () => runUpdate();

  const handleUpdateFromForkAsIs = () => runUpdate({ acknowledgeFork: true });

  // Reconcile a half-updated install (issue #1779) — same machinery as a normal
  // update, but `reconcile: true` lets the server run update.sh even with no
  // newer release. Fork-aware variants mirror the release-update buttons.
  const handleReconcile = () => runUpdate({ reconcile: true });

  const handleReconcileFromForkAsIs = () => runUpdate({ acknowledgeFork: true, reconcile: true });

  // Shared fork-sync-then-run: syncs the fork, then runs update/reconcile with
  // the freshly fetched status. `extraOpts` distinguishes update vs reconcile.
  const syncForkThenRun = async (extraOpts = {}) => {
    setSyncingFork(true);
    setForkSyncError(null);
    const synced = await api.syncPortosFork({}, { silent: true }).catch(err => {
      setForkSyncError(err.message);
      return null;
    });
    setSyncingFork(false);
    if (!synced) return;
    if (synced.alreadyUpToDate) {
      toast.success(`Fork already up to date with ${status?.upstream?.fullName || 'upstream'}`);
    } else {
      toast.success(`Synced ${synced.fullName} from ${synced.source}`);
    }
    const fresh = await fetchStatus();
    await runUpdate(extraOpts, fresh);
  };

  const handleSyncForkAndUpdate = () => syncForkThenRun({});

  const handleSyncForkAndReconcile = () => syncForkThenRun({ reconcile: true });

  const handleSyncForkOnly = async () => {
    setSyncingFork(true);
    setForkSyncError(null);
    const synced = await api.syncPortosFork({}, { silent: true }).catch(err => {
      setForkSyncError(err.message);
      return null;
    });
    setSyncingFork(false);
    if (!synced) return;
    toast.success(
      synced.alreadyUpToDate
        ? `Fork already up to date with ${status?.upstream?.fullName || 'upstream'}`
        : `Synced ${synced.fullName} from ${synced.source}`
    );
    await fetchStatus();
  };

  const handleIgnore = async (version) => {
    const result = await api.ignoreUpdateVersion(version).catch(() => null);
    if (!result) return;
    fetchStatus();
    toast.success(`v${version} ignored`);
  };

  const handleClearIgnored = async () => {
    const result = await api.clearIgnoredVersions().catch(() => null);
    if (!result) return;
    fetchStatus();
    toast.success('Ignored versions cleared');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <BrailleSpinner text="Loading update status" />
      </div>
    );
  }

  const release = status?.latestRelease;
  const hasUpdate = status?.updateAvailable;
  const remote = status?.remoteInfo;
  const upstreamName = status?.upstream?.fullName || 'atomantic/PortOS';
  const isFork = !!remote?.isFork;
  const lastForkSync = status?.lastForkSync;
  // Server is the source of truth for the freshness window — don't
  // re-implement the time math here.
  const forkSyncFresh = !!status?.forkSyncFresh;

  // Install-sync state (issue #1779) — surfaces a half-updated install (bare
  // `git pull`, no ./update.sh). Distinct from "a new release is available".
  const installState = status?.installState;
  const outOfSync = !!installState?.outOfSync;
  const installIssues = [];
  if (installState?.runningStaleCode) {
    installIssues.push('Running code is older than what’s checked out — a restart/update is required.');
  }
  if (installState?.staleDeps?.stale) {
    const ws = (installState.staleDeps.workspaces || []).filter(w => w.stale).map(w => w.name);
    installIssues.push(`Dependencies are out of date${ws.length ? ` (${ws.join(', ')})` : ''} — run update.sh to npm install.`);
  }
  if (installState?.staleBuild === true) {
    installIssues.push('The served client build is older than the UI source — a rebuild is needed.');
  }
  if (installState?.pendingMigrations?.count > 0) {
    const n = installState.pendingMigrations.count;
    installIssues.push(`${n} pending data migration${n === 1 ? '' : 's'} not yet applied.`);
  }

  return (
    <div className="space-y-6">
      {/* Current Version + Check Button */}
      <div className="flex items-end justify-between">
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Current Version</div>
          <div className="flex items-center gap-2">
            <Tag size={16} className="text-port-accent shrink-0" />
            <span className="text-lg font-mono text-white">v{status?.currentVersion || '?'}</span>
          </div>
        </div>
        <button
          onClick={handleCheck}
          disabled={checking || updating}
          className="px-4 py-2 bg-port-border text-white rounded-lg text-sm flex items-center gap-2 hover:bg-port-border/80 disabled:opacity-50"
        >
          <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
          {checking ? 'Checking...' : 'Check for Updates'}
        </button>
      </div>

      {/* Origin / Fork status */}
      {remote?.hasOrigin && (
        <div className={`p-3 rounded-lg border text-sm ${
          isFork
            ? 'border-port-warning/40 bg-port-warning/5'
            : remote.isUpstream
              ? 'border-port-border bg-port-card'
              : 'border-port-border bg-port-card'
        }`}>
          <div className="flex items-start gap-2">
            {isFork ? <GitFork size={16} className="text-port-warning shrink-0 mt-0.5" /> : <GitBranch size={16} className="text-gray-400 shrink-0 mt-0.5" />}
            <div className="flex-1">
              <div className="text-white">
                {remote.isUpstream && <>Running from upstream <span className="font-mono">{remote.fullName}</span></>}
                {isFork && <>Running from fork <span className="font-mono">{remote.fullName}</span></>}
                {!remote.isUpstream && !isFork && <>Origin: <span className="font-mono">{remote.fullName || remote.originUrl}</span></>}
              </div>
              {isFork && (
                <div className="text-xs text-gray-400 mt-1 space-y-1">
                  <div>Updates pull from your fork's <span className="font-mono">main</span>. Sync it from <span className="font-mono">{upstreamName}</span> before updating, or apply upstream changes onto a working branch first to preserve customizations.</div>
                  <div>Tip: PR shareable fixes upstream; keep private changes on a separate branch and rebase that branch onto <span className="font-mono">main</span> after each sync.</div>
                  {forkSyncFresh && (
                    <div className="text-port-success">✓ Fork synced {new Date(lastForkSync.syncedAt).toLocaleTimeString()} — ready to update.</div>
                  )}
                </div>
              )}
              {forkSyncError && (
                <div className="mt-2 text-xs text-port-error whitespace-pre-wrap">{forkSyncError}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Install out of sync (issue #1779) — distinct from "new release available" */}
      {outOfSync && (
        <div className="p-4 rounded-lg border border-port-warning/50 bg-port-warning/5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={18} className="text-port-warning shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-sm text-white font-medium">Install out of sync</div>
              <div className="text-xs text-gray-400 mt-1">
                Your checked-out code is ahead of what’s running or installed — this happens after a
                manual <span className="font-mono">git pull</span> without <span className="font-mono">./update.sh</span>.
                Reconcile to finish the update (install dependencies, rebuild, run migrations, restart).
              </div>
              <ul className="text-xs text-gray-300 mt-2 space-y-1 list-disc list-inside">
                {installIssues.map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-2 mt-3">
                {isFork ? (
                  <>
                    <button
                      onClick={handleSyncForkAndReconcile}
                      disabled={updating || polling || syncingFork}
                      className="px-4 py-2 bg-port-warning text-black rounded-lg text-sm flex items-center gap-2 hover:bg-port-warning/80 disabled:opacity-50"
                      title={`Fast-forwards ${remote?.fullName} main from ${upstreamName}, then runs update.sh to reconcile the install.`}
                    >
                      <GitFork size={14} className={syncingFork ? 'animate-pulse' : ''} />
                      {syncingFork ? 'Syncing fork...' : updating ? 'Reconciling...' : polling ? 'Restarting...' : 'Sync Fork & Reconcile'}
                    </button>
                    <button
                      onClick={handleReconcileFromForkAsIs}
                      disabled={updating || polling || syncingFork}
                      className="px-4 py-2 bg-port-border text-gray-300 rounded-lg text-sm flex items-center gap-2 hover:bg-port-border/80 hover:text-white disabled:opacity-50"
                      title="Skip the fork sync and reconcile from your fork's origin as-is."
                    >
                      <RefreshCw size={14} className={updating ? 'animate-spin' : ''} />
                      Reconcile from Fork As-Is
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleReconcile}
                    disabled={updating || polling || syncingFork}
                    className="px-4 py-2 bg-port-warning text-black rounded-lg text-sm flex items-center gap-2 hover:bg-port-warning/80 disabled:opacity-50"
                    title="Run update.sh to install dependencies, rebuild the client, run migrations, and restart."
                  >
                    <RefreshCw size={14} className={updating ? 'animate-spin' : ''} />
                    {updating ? 'Reconciling...' : polling ? 'Restarting...' : 'Reconcile Now'}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Available Update */}
      {release && (
        <div className={`p-4 rounded-lg border ${hasUpdate ? 'border-port-accent/50 bg-port-accent/5' : 'border-port-border bg-port-card'}`}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400">Latest Release:</span>
              <span className="text-lg font-mono text-white">v{release.version}</span>
              {hasUpdate && (
                <span className="px-2 py-0.5 bg-port-accent/20 text-port-accent text-xs rounded-full">New</span>
              )}
            </div>
            {release.url && (
              <a
                href={release.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-gray-400 hover:text-white transition-colors flex items-center gap-1 text-xs"
              >
                <ExternalLink size={12} /> GitHub
              </a>
            )}
          </div>
          {release.publishedAt && (
            <div className="text-xs text-gray-500 mb-2">
              Released {new Date(release.publishedAt).toLocaleDateString()}
            </div>
          )}
          {release.body && (
            <div className="mt-3 p-3 bg-port-bg rounded border border-port-border">
              <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Release Notes</div>
              <div className="max-h-[32rem] overflow-y-auto">
                <MarkdownOutput content={release.body} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Update Actions */}
      {hasUpdate && (
        <div className="flex flex-wrap gap-2">
          {isFork ? (
            <>
              <button
                onClick={handleSyncForkAndUpdate}
                disabled={updating || polling || syncingFork}
                className="px-4 py-2 bg-port-accent text-white rounded-lg text-sm flex items-center gap-2 hover:bg-port-accent/80 disabled:opacity-50"
                title={`Fast-forwards ${remote?.fullName} main from ${upstreamName} via gh repo sync, then runs the local update. Refuses to overwrite divergent fork commits.`}
              >
                <GitFork size={14} className={syncingFork ? 'animate-pulse' : ''} />
                {syncingFork ? 'Syncing fork...' : updating ? 'Updating...' : polling ? 'Restarting...' : 'Sync Fork & Update'}
              </button>
              <button
                onClick={handleSyncForkOnly}
                disabled={updating || polling || syncingFork}
                className="px-4 py-2 bg-port-border text-white rounded-lg text-sm flex items-center gap-2 hover:bg-port-border/80 disabled:opacity-50"
                title={`Run gh repo sync ${remote?.fullName} only — useful if you want to merge upstream into a feature branch yourself before applying.`}
              >
                <GitFork size={14} />
                Sync Fork Only
              </button>
              <button
                onClick={handleUpdateFromForkAsIs}
                disabled={updating || polling || syncingFork}
                className="px-4 py-2 bg-port-border text-gray-400 rounded-lg text-sm flex items-center gap-2 hover:bg-port-border/80 hover:text-white disabled:opacity-50"
                title="Skip the fork sync and pull from your fork's origin as-is. Use this if you already merged upstream into your fork via your own workflow."
              >
                <Download size={14} className={updating ? 'animate-bounce' : ''} />
                Update from Fork As-Is
              </button>
            </>
          ) : (
            <button
              onClick={handleUpdate}
              disabled={updating || polling}
              className="px-4 py-2 bg-port-accent text-white rounded-lg text-sm flex items-center gap-2 hover:bg-port-accent/80 disabled:opacity-50"
            >
              <Download size={14} className={updating ? 'animate-bounce' : ''} />
              {updating ? 'Updating...' : polling ? 'Restarting...' : 'Update Now'}
            </button>
          )}
          {release && (
            <button
              onClick={() => handleIgnore(release.version)}
              disabled={updating || syncingFork}
              className="px-4 py-2 bg-port-border text-gray-400 rounded-lg text-sm flex items-center gap-2 hover:bg-port-border/80 hover:text-white disabled:opacity-50"
            >
              <XCircle size={14} />
              Ignore v{release.version}
            </button>
          )}
        </div>
      )}

      {/* Last Check */}
      {status?.lastCheck && (
        <div className="text-xs text-gray-500">
          Last checked: {formatDateTime(status.lastCheck)}
        </div>
      )}

      {/* Update Progress */}
      {steps.length > 0 && (
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Update Progress</div>
          <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-2">
            {steps.map(({ step, status: stepStatus, message }) => (
              <div key={step} className="flex items-center gap-3">
                <StepIndicator status={stepStatus} />
                <span className="text-sm text-white font-medium">{STEP_LABELS[step] || step}</span>
                <span className="text-xs text-gray-500 flex-1 truncate">{message}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Update Error */}
      {updateError && (
        <Banner tone="error" size="md" icon={AlertTriangle}>{updateError}</Banner>
      )}

      {/* Last Update Result */}
      {status?.lastUpdateResult && (
        <div>
          <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Last Update</div>
          <div className={`p-3 rounded-lg border ${
            status.lastUpdateResult.success
              ? 'border-port-success/30 bg-port-success/5'
              : 'border-port-error/30 bg-port-error/5'
          }`}>
            <div className="flex items-center gap-2">
              {status.lastUpdateResult.success
                ? <Check size={14} className="text-port-success" />
                : <XCircle size={14} className="text-port-error" />
              }
              <span className="text-sm text-white">
                v{status.lastUpdateResult.version} — {status.lastUpdateResult.success ? 'Success' : 'Failed'}
              </span>
              {status.lastUpdateResult.completedAt && (
                <span className="text-xs text-gray-500">
                  {formatDateTime(status.lastUpdateResult.completedAt)}
                </span>
              )}
            </div>
            {status.lastUpdateResult.log && (
              <pre className="text-xs text-gray-400 mt-2 font-mono">{status.lastUpdateResult.log}</pre>
            )}
          </div>
        </div>
      )}

      {/* Ignored Versions */}
      {status?.ignoredVersions?.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Ignored Versions</div>
            <button
              onClick={handleClearIgnored}
              className="text-xs text-gray-500 hover:text-white flex items-center gap-1"
            >
              <Trash2 size={12} /> Clear All
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {status.ignoredVersions.map(v => (
              <span
                key={v}
                className="px-2 py-1 bg-port-card border border-port-border rounded text-sm text-gray-400 font-mono"
              >
                v{v}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
