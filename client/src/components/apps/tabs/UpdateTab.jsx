import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Download, XCircle, Check, Loader, AlertTriangle, Trash2, ExternalLink, Tag, GitFork, GitBranch } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import Banner from '../../ui/Banner';
import * as api from '../../../services/api';
import socket from '../../../services/socket';
import { useAutoRefetch } from '../../../hooks/useAutoRefetch';

const STEP_LABELS = {
  starting: 'Starting update',
  'git-pull': 'Pulling latest changes',
  'pm2-stop': 'Stopping apps',
  'npm-install': 'Installing dependencies',
  setup: 'Running setup',
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

  const fetchStatus = useCallback(async () => {
    const data = await api.getUpdateStatus().catch(() => null);
    if (data) setStatus(data);
    setLoading(false);
    return data;
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Socket event listeners for update progress
  useEffect(() => {
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
        setUpdating(false);
        setPolling(true);
        toast.loading('PortOS is restarting...', { id: 'portos-update-restart', duration: Infinity });
      }
    };

    const handleComplete = ({ success, newVersion, versionKnown }) => {
      setUpdating(false);
      if (success) {
        // Use server-reported actual version when available; fall back to target
        if (versionKnown && newVersion) {
          targetVersionRef.current = newVersion;
        }
        setPolling(true);
        toast.loading('PortOS is restarting...', { id: 'portos-update-restart', duration: Infinity });
      }
    };

    const handleError = ({ message }) => {
      setUpdating(false);
      setPolling(false);
      toast.dismiss('portos-update-restart');
      setUpdateError(message);
    };

    socket.on('portos:update:step', handleStep);
    socket.on('portos:update:complete', handleComplete);
    socket.on('portos:update:error', handleError);

    return () => {
      socket.off('portos:update:step', handleStep);
      socket.off('portos:update:complete', handleComplete);
      socket.off('portos:update:error', handleError);
    };
  }, []);

  // Poll health endpoint after restart to detect new version. The hook's
  // `enabled: polling` gate handles teardown automatically when polling flips
  // off; attemptsRef resets on every fresh polling cycle.
  useEffect(() => {
    if (polling) attemptsRef.current = 0;
  }, [polling]);

  const pollHealth = useCallback(async () => {
    attemptsRef.current += 1;
    const ok = await api.checkHealth().catch(() => null);
    const preUpdateVersion = preUpdateVersionRef.current;
    if (ok?.version && (ok.version === targetVersionRef.current || (preUpdateVersion && ok.version !== preUpdateVersion))) {
      setPolling(false);
      toast.success(`Updated to v${ok.version}`, { id: 'portos-update-restart' });
      setTimeout(() => window.location.reload(), 1000);
      return;
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

  const handleSyncForkAndUpdate = async () => {
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
    await runUpdate({}, fresh);
  };

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
          Last checked: {new Date(status.lastCheck).toLocaleString()}
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
                  {new Date(status.lastUpdateResult.completedAt).toLocaleString()}
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
