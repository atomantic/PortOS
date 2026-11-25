import { useState, useEffect, useCallback, useRef } from 'react';
import PageHeader from '../components/PageHeader';
import { useSocketResource } from '../hooks/useSocketResource';
import useMounted from '../hooks/useMounted';
import { Globe, RefreshCw, Settings, FileText, ExternalLink, Mail, MessageSquare } from 'lucide-react';
import {
  getBrowserStatus,
  getBrowserConfig,
  updateBrowserConfig,
  getBrowserUpdatePreflight,
  restartBrowser,
  getBrowserLogs,
  navigateBrowser,
  deleteBrowserDownload,
} from '../services/apiSystem.js';
import BrailleSpinner from '../components/BrailleSpinner';
import toast from '../components/ui/Toast';
import { BrowserConfigPanel } from '../components/browser/BrowserConfigPanel';
import { BrowserControls, BrowserRestartBanner } from '../components/browser/BrowserControls';
import { BrowserStatusCard, BrowserSidebar } from '../components/browser/BrowserStatus';
import { BrowserPagesSection, BrowserDownloadsSection } from '../components/browser/BrowserContentSections';

const STATUS_EVENTS = ['browser:changed'];
const readStatus = () => getBrowserStatus({ silent: true });

function deriveMacAppBundle(chromePath) {
  if (!chromePath?.trim()) return null;
  const normalized = chromePath.trim().replaceAll('\\', '/');
  const appIndex = normalized.toLowerCase().indexOf('.app/');
  return appIndex >= 0 ? normalized.slice(0, appIndex + '.app'.length) : null;
}

export default function BrowserPage() {
  const { data: status, loading, error, refetch: fetchStatus, updateData: setStatus } =
    useSocketResource(readStatus, { namespace: 'browser', events: STATUS_EVENTS });
  const statusError = error?.message;
  const [actionLoading, setActionLoading] = useState(null);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restartPreflight, setRestartPreflight] = useState(null);
  const restartGeneration = useRef(0);
  const mounted = useMounted();
  const [showConfig, setShowConfig] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [showPages, setShowPages] = useState(true);
  const [logs, setLogs] = useState('');
  const [config, setConfig] = useState(null);
  const [configDraft, setConfigDraft] = useState(null);
  const [navUrl, setNavUrl] = useState('');
  const [showDownloads, setShowDownloads] = useState(true);
  const fetchLogs = useCallback(async () => {
    const data = await getBrowserLogs(100).catch(() => null);
    if (data) {
      const combined = [data.stdout, data.stderr].filter(Boolean).join('\n');
      setLogs(combined || '(no logs)');
    }
  }, []);

  // Load config when settings panel opens
  useEffect(() => {
    if (showConfig && !config) {
      getBrowserConfig().then(c => {
        setConfig(c);
        setConfigDraft(c);
      }).catch(err => console.warn('load browser config:', err?.message ?? String(err)));
    }
  }, [showConfig, config]);

  // Load logs when panel opens
  useEffect(() => {
    if (showLogs) fetchLogs();
  }, [showLogs, fetchLogs]);

  const handleAction = useCallback(async (action, fn) => {
    setActionLoading(action);
    const result = await fn({ silent: true }).catch(err => {
      toast.error(`Failed to ${action}: ${err.message}`);
      return null;
    });
    if (result) {
      if ((action === 'launch' || action === 'restart') && !result.connected) {
        toast.error('Browser process started, but Chrome is not connected yet. Check the recovery steps below if it stays disconnected.');
      } else if (action === 'restart' && ['restart-required', 'downgrade-risk'].includes(result.updateVerification?.state)) {
        toast.error('The browser restarted, but its running and installed Chrome versions still differ. Review the update status.');
      } else if (action === 'restart' && result.updateVerification?.state === 'pending') {
        toast.success('Browser restarted; version verification is pending.');
      } else if (action === 'restart' && result.updateVerification?.state === 'unverified') {
        toast.error('Browser restarted, but the reviewed version could not be verified. Review Chrome update status.');
      } else {
        toast.success(`Browser ${action} successful`);
      }
      setStatus(prev => prev ? { ...prev, ...result } : prev);
      await fetchStatus();
    }
    setActionLoading(null);
  }, [fetchStatus, setStatus]);

  const reviewRestart = useCallback(async () => {
    const generation = ++restartGeneration.current;
    setConfirmRestart(true);
    setRestartPreflight(null);
    setActionLoading('restart-preflight');
    const observed = await getBrowserUpdatePreflight({ silent: true }).catch(error =>
      ['HOST_CONTROL_FORBIDDEN', 'AUTH_REQUIRED'].includes(error.code)
        ? { state: 'forbidden', message: error.message } : { state: 'unverified', ticket: null });
    if (!mounted.current || generation !== restartGeneration.current) return;
    setRestartPreflight(observed);
    setActionLoading(null);
  }, [mounted]);

  const cancelRestart = () => {
    restartGeneration.current += 1;
    setConfirmRestart(false);
    setRestartPreflight(null);
    setActionLoading(null);
  };

  const confirmBrowserRestart = () => {
    const ticket = restartPreflight?.ticket;
    cancelRestart();
    handleAction('restart', options => restartBrowser({ ...options, ...(ticket ? { ticket } : {}) }));
  };

  const handleChromePathChange = (chromePath) => setConfigDraft(d => {
    const currentAppBundle = deriveMacAppBundle(d.chromePath);
    const macAppBundle = !d.macAppBundle || d.macAppBundle === currentAppBundle
      ? deriveMacAppBundle(chromePath)
      : d.macAppBundle;
    return { ...d, chromePath, macAppBundle };
  });

  const handleSaveConfig = useCallback(async () => {
    if (!configDraft) return;
    const saved = await updateBrowserConfig(configDraft, { silent: true }).catch(err => {
      toast.error(`Failed to save config: ${err.message}`);
      return null;
    });
    if (saved) {
      setStatus(prev => prev ? { ...prev, config: saved } : prev);
      setConfig(saved);
      setConfigDraft(saved);
      toast.success('Browser config saved — restart browser to apply changes');
    }
  }, [configDraft, setStatus]);

  const handleDeleteDownload = useCallback(async (name) => {
    const ok = await deleteBrowserDownload(name, { silent: true }).then(() => true).catch(err => {
      toast.error(`Failed to delete: ${err.message}`);
      return false;
    });
    if (ok) {
      setStatus(prev => ({
        ...prev,
        downloads: { ...prev.downloads, files: prev.downloads.files.filter(f => f.name !== name) }
      }));
    }
  }, [setStatus]);

  const handleNavigate = useCallback(async () => {
    const trimmed = navUrl.trim();
    if (!trimmed) return;
    const url = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    setActionLoading('navigate');
    const result = await navigateBrowser(url, { silent: true }).catch(err => {
      toast.error(`Failed to navigate: ${err.message}`);
      return null;
    });
    if (result) {
      toast.success(`Opened ${url}`);
      setNavUrl('');
      setStatus(prev => {
        if (!prev) return prev;
        const pages = [...(prev.pages || []).filter(page => page.id !== result.id), result];
        return { ...prev, pages, pageCount: pages.length };
      });
      await fetchStatus();
    }
    setActionLoading(null);
  }, [navUrl, fetchStatus, setStatus]);

  const isRunning = status?.process?.status === 'online';
  const isConnected = status?.connected;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Globe}
        title="Browser"
        subtitle="Manage the authenticated CDP/Playwright browser"
        actions={<>
          <button
            onClick={() => setShowConfig(s => !s)}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              showConfig
                ? 'bg-port-accent text-white'
                : 'bg-port-card border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50'
            }`}
          >
            <Settings size={16} />
            <span>Config</span>
          </button>
          <button
            onClick={() => { setShowLogs(s => !s); }}
            className={`flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              showLogs
                ? 'bg-port-accent text-white'
                : 'bg-port-card border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50'
            }`}
          >
            <FileText size={16} />
            <span>Logs</span>
          </button>
          <button
            onClick={fetchStatus}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg bg-port-card border border-port-border text-gray-400 hover:text-white hover:border-port-accent/50 transition-colors disabled:opacity-50"
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
            <span>Refresh</span>
          </button>
        </>}
      />
      <div className="flex-1 min-h-0 overflow-auto p-4 md:p-6">

      {statusError && (
        <p role="alert" className="mb-4 text-sm text-port-error">
          Could not refresh browser status: {statusError}. Use Refresh to try again.
        </p>
      )}

      {showConfig && configDraft && (
        <BrowserConfigPanel
          configDraft={configDraft}
          setConfigDraft={setConfigDraft}
          handleChromePathChange={handleChromePathChange}
          handleSaveConfig={handleSaveConfig}
        />
      )}

      {/* Logs panel */}
      {showLogs && (
        <div className="mb-6 bg-port-card border border-port-border rounded-xl overflow-hidden">
          <div className="flex items-center justify-between p-3 border-b border-port-border">
            <h3 className="text-sm font-semibold text-white">Recent Logs</h3>
            <button
              onClick={fetchLogs}
              aria-label="Refresh logs"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-xs text-gray-400 hover:text-white transition-colors"
            >
              <RefreshCw size={14} />
            </button>
          </div>
          <pre className="p-3 text-xs text-gray-400 font-mono overflow-auto max-h-64 whitespace-pre-wrap break-all">
            {logs || <BrailleSpinner text="Loading logs" />}
          </pre>
        </div>
      )}

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Status + Controls */}
        <div className="lg:col-span-2 min-w-0 space-y-6">
          <BrowserControls
            status={status}
            isRunning={isRunning}
            isConnected={isConnected}
            loading={loading}
            actionLoading={actionLoading}
            handleAction={handleAction}
            reviewRestart={reviewRestart}
            setShowLogs={setShowLogs}
            setShowConfig={setShowConfig}
          />
          {confirmRestart && isRunning && (
            <BrowserRestartBanner
              restartPreflight={restartPreflight}
              actionLoading={actionLoading}
              confirmBrowserRestart={confirmBrowserRestart}
              cancelRestart={cancelRestart}
            />
          )}
          <BrowserStatusCard status={status} isRunning={isRunning} isConnected={isConnected} loading={loading} />
          {/* Navigate to URL */}
          {isConnected && (
            <div className="bg-port-card border border-port-border rounded-xl p-5">
              <h3 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
                <ExternalLink size={20} className="text-port-accent" />
                Open URL
              </h3>
              <form
                onSubmit={e => { e.preventDefault(); handleNavigate(); }}
                className="flex gap-2"
              >
                <input
                  type="text"
                  aria-label="URL to open"
                  value={navUrl}
                  onChange={e => setNavUrl(e.target.value)}
                  placeholder="https://example.com"
                  className="min-w-0 flex-1 px-3 py-2 bg-port-bg border border-port-border rounded-lg text-white text-sm focus:outline-hidden focus:border-port-accent placeholder-gray-600"
                />
                <button
                  type="submit"
                  disabled={!navUrl.trim() || actionLoading !== null}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-accent text-white rounded-lg hover:bg-port-accent/80 transition-colors disabled:opacity-50"
                >
                  {actionLoading === 'navigate'
                    ? <RefreshCw size={16} className="animate-spin" />
                    : <Globe size={16} />
                  }
                  Go
                </button>
              </form>
              <div className="flex flex-wrap gap-2 mt-3">
                {[
                  { label: 'Outlook', url: 'https://outlook.office.com/mail/', icon: Mail },
                  { label: 'Teams', url: 'https://teams.microsoft.com/v2/', icon: MessageSquare },
                ].map(({ label, url, icon: Icon }) => (
                  <button
                    key={label}
                    onClick={() => {
                      setNavUrl(url);
                      setActionLoading('navigate');
                      navigateBrowser(url, { silent: true }).then(() => {
                        toast.success(`Opened ${label}`);
                        setNavUrl('');
                        fetchStatus();
                      }).catch(err => toast.error(`Failed to navigate: ${err.message}`))
                        .finally(() => setActionLoading(null));
                    }}
                    disabled={loading || !status || actionLoading !== null}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-port-bg border border-port-border text-gray-400 rounded-lg hover:text-white hover:border-port-accent/50 transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    <Icon size={14} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          <BrowserPagesSection status={status} isConnected={isConnected} showPages={showPages} setShowPages={setShowPages} />
          <BrowserDownloadsSection status={status} showDownloads={showDownloads} setShowDownloads={setShowDownloads} handleDeleteDownload={handleDeleteDownload} />
        </div>

        <BrowserSidebar status={status} />
      </div>
      </div>
    </div>
  );
}
