import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Download, XCircle, Check, Loader, AlertTriangle, Trash2, ExternalLink, Tag } from 'lucide-react';
import toast from '../../ui/Toast';
import BrailleSpinner from '../../BrailleSpinner';
import MarkdownOutput from '../../cos/MarkdownOutput';
import * as api from '../../../services/api';
import socket from '../../../services/socket';

const STEP_LABELS = {
  starting: 'Starting update',
  'git-fetch': 'Fetching tags',
  'git-checkout': 'Checking out release',
  'npm-install': 'Installing dependencies',
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
  const pollRef = useRef(null);
  const targetVersionRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    const data = await api.getUpdateStatus().catch(() => null);
    if (data) setStatus(data);
    setLoading(false);
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

    const handleComplete = ({ success, newVersion }) => {
      setUpdating(false);
      if (success) {
        targetVersionRef.current = newVersion;
        setPolling(true);
        toast.loading('PortOS is restarting...', { id: 'portos-update-restart', duration: Infinity });
      }
    };

    const handleError = ({ message }) => {
      setUpdating(false);
      setPolling(false);
      if (pollRef.current) clearInterval(pollRef.current);
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

  // Poll health endpoint after restart to detect new version
  useEffect(() => {
    if (!polling) return;

    let attempts = 0;
    const maxAttempts = 30;

    pollRef.current = setInterval(async () => {
      attempts++;
      const ok = await api.checkHealth()
        .catch(() => null);

      if (ok?.version === targetVersionRef.current) {
        clearInterval(pollRef.current);
        setPolling(false);
        toast.success(`Updated to v${targetVersionRef.current}`, { id: 'portos-update-restart' });
        setTimeout(() => window.location.reload(), 1000);
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(pollRef.current);
        setPolling(false);
        toast.error('Restart timed out — try reloading manually', { id: 'portos-update-restart' });
      }
    }, 2000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [polling]);

  const handleCheck = async () => {
    setChecking(true);
    const result = await api.checkForUpdate().catch(() => null);
    if (result) setStatus(prev => ({ ...(prev ?? {}), ...result }));
    setChecking(false);
  };

  const handleUpdate = async () => {
    // Set target version BEFORE executing so it's available when the
    // restarting step arrives via socket (which may beat the HTTP response)
    if (status?.latestRelease?.version) {
      targetVersionRef.current = status.latestRelease.version;
    }
    setUpdating(true);
    setSteps([]);
    setUpdateError(null);
    const result = await api.executePortosUpdate().catch(err => {
      setUpdateError(err.message);
      setUpdating(false);
      return null;
    });
    // Update from response if available (should match, but server is authoritative)
    if (result?.tag) {
      targetVersionRef.current = result.tag.replace(/^v/, '');
    }
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
          <button
            onClick={handleUpdate}
            disabled={updating || polling}
            className="px-4 py-2 bg-port-accent text-white rounded-lg text-sm flex items-center gap-2 hover:bg-port-accent/80 disabled:opacity-50"
          >
            <Download size={14} className={updating ? 'animate-bounce' : ''} />
            {updating ? 'Updating...' : polling ? 'Restarting...' : 'Update Now'}
          </button>
          {release && (
            <button
              onClick={() => handleIgnore(release.version)}
              disabled={updating}
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
        <div className="flex items-start gap-2 p-3 bg-port-error/10 border border-port-error/30 rounded-lg">
          <AlertTriangle size={16} className="text-port-error shrink-0 mt-0.5" />
          <span className="text-sm text-port-error">{updateError}</span>
        </div>
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
