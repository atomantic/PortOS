import { useState, useEffect, useRef, useCallback } from 'react';
import { Cpu, Box, ArrowRightLeft, Download, Trash2, RefreshCw, Search, Plus, ExternalLink } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { formatBytes } from '../../utils/formatters';
import {
  getLocalLlmStatus, getLocalLlmCatalog, installLocalLlmModel,
  deleteLocalLlmModel, switchLocalLlmBackend, migrateLocalLlmBackend, installLocalLlmBackend
} from '../../services/api';
import socket from '../../services/socket';

const BACKENDS = [
  { id: 'ollama', label: 'Ollama', icon: Cpu },
  { id: 'lmstudio', label: 'LM Studio', icon: Box }
];
const labelFor = (id) => BACKENDS.find((b) => b.id === id)?.label || id;

const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';

function BackendCard({ backend, status, isActive, busy, actionInProgress, runAction, setConfirmAction }) {
  const data = status?.[backend.id];
  const Icon = backend.icon;
  const other = backend.id === 'ollama' ? 'lmstudio' : 'ollama';
  const statusLabel = data?.available ? 'Running' : data?.installed ? 'Installed (stopped)' : 'Not installed';
  const statusColor = data?.available ? 'bg-port-success' : data?.installed ? 'bg-port-warning' : 'bg-gray-600';

  return (
    <div className="bg-port-bg border border-port-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Icon size={14} />
          {backend.label}
        </div>
        <div className="flex items-center gap-1.5">
          {isActive && <span className="text-xs px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded">Active</span>}
          <span className={`w-2 h-2 rounded-full ${statusColor}`} />
        </div>
      </div>

      <div className="text-sm text-white">{statusLabel}</div>
      <div className="text-xs text-gray-400">
        {data?.modelCount ?? 0} model{(data?.modelCount ?? 0) === 1 ? '' : 's'} installed
        {data?.version && <> · v{data.version}</>}
      </div>

      {!data?.installed && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-port-border/50">
          {data?.canAutoInstall ? (
            <button
              onClick={() => runAction(
                `install-backend-${backend.id}`,
                () => installLocalLlmBackend(backend.id),
                (r) => r?.note ? `Installed ${backend.label} — ${r.note}` : `Installed ${backend.label}`
              )}
              disabled={busy}
              className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
              title="Install via Homebrew (macOS) / official installer (Linux)"
            >
              {actionInProgress === `install-backend-${backend.id}` ? <BrailleSpinner /> : <Download size={12} />}
              Install {backend.label}
            </button>
          ) : (
            <a
              href={data?.downloadUrl}
              target="_blank"
              rel="noreferrer"
              className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white no-underline`}
            >
              <ExternalLink size={12} />
              Get {backend.label}
            </a>
          )}
        </div>
      )}

      {data?.installed && !isActive && (
        <div className="flex flex-wrap gap-1.5 pt-1 border-t border-port-border/50">
          <button
            onClick={() => setConfirmAction({
              type: 'migrate',
              label: `Migrate to ${backend.label}?`,
              detail: `Provisions the models you have on ${labelFor(other)} onto ${backend.label}, then makes ${backend.label} the active backend. GGUF weights are copied locally (no re-download) where possible; anything that can't be copied (LM Studio MLX-format, sharded, or multimodal models) is re-pulled, which can take a while.`,
              action: () => runAction(`migrate-${backend.id}`, () => migrateLocalLlmBackend(backend.id), `Migrated to ${backend.label}`)
            })}
            disabled={busy}
            className={`${btnClass} bg-port-accent/20 hover:bg-port-accent/30 text-port-accent`}
          >
            <ArrowRightLeft size={12} />
            Migrate to {backend.label}
          </button>
          <button
            onClick={() => runAction(`switch-${backend.id}`, () => switchLocalLlmBackend(backend.id), `Switched to ${backend.label}`)}
            disabled={busy}
            className={`${btnClass} bg-port-border hover:bg-port-border/70 text-white`}
            title="Make this the active backend without moving any models"
          >
            {actionInProgress === `switch-${backend.id}` ? <BrailleSpinner /> : <ArrowRightLeft size={12} />}
            Switch
          </button>
        </div>
      )}
    </div>
  );
}

export function LocalLlmTab() {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState('ollama');
  const [catalog, setCatalog] = useState([]);
  const [query, setQuery] = useState('');
  const [manualId, setManualId] = useState('');
  const [actionInProgress, setActionInProgress] = useState(null);
  const [progressMsg, setProgressMsg] = useState('');
  const [confirmAction, setConfirmAction] = useState(null);
  const progressTimer = useRef(null);
  const selectedInitialized = useRef(false);

  const loadStatus = useCallback(() => {
    setLoading(true);
    return getLocalLlmStatus()
      .then((s) => {
        setStatus(s);
        // Default the model-management view to the active backend on first load.
        if (!selectedInitialized.current && s?.backend) {
          setSelected(s.backend);
          selectedInitialized.current = true;
        }
      })
      .catch(() => toast.error('Failed to load local LLM status'))
      .finally(() => setLoading(false));
  }, []);

  const loadCatalog = useCallback((backend, q) => {
    getLocalLlmCatalog(backend, q)
      .then((r) => setCatalog(r.models || []))
      .catch(() => setCatalog([]));
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);
  // Debounce so typing in the search box doesn't fire a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => loadCatalog(selected, query), 250);
    return () => clearTimeout(t);
  }, [selected, query, loadCatalog]);

  useEffect(() => {
    const handleProgress = (data) => {
      clearTimeout(progressTimer.current);
      setProgressMsg(data.message || '');
      if (data.event === 'complete') {
        progressTimer.current = setTimeout(() => setProgressMsg(''), 3000);
        loadStatus();
        loadCatalog(selected, query);
      }
      if (data.event === 'error') {
        progressTimer.current = setTimeout(() => setProgressMsg(''), 5000);
      }
    };
    socket.on('localLlm:progress', handleProgress);
    return () => {
      socket.off('localLlm:progress', handleProgress);
      clearTimeout(progressTimer.current);
    };
  }, [loadStatus, loadCatalog, selected, query]);

  const runAction = useCallback((key, fn, successMsg) => {
    setConfirmAction(null);
    setActionInProgress(key);
    return fn()
      .then((result) => {
        if (successMsg) toast.success(typeof successMsg === 'function' ? successMsg(result) : successMsg);
        loadStatus();
        loadCatalog(selected, query);
      })
      .catch(() => { /* request() surfaces API errors as a toast */ })
      .finally(() => setActionInProgress(null));
  }, [loadStatus, loadCatalog, selected, query]);

  const busy = actionInProgress != null;
  const selectedData = status?.[selected];
  const installedModels = selectedData?.models || [];

  // LM Studio's REST fallback returns { pending: true } — the download was only
  // queued, not finished — so don't claim "installed" in that case.
  const install = (modelId) => runAction(`install-${modelId}`, () => installLocalLlmModel(selected, modelId),
    (r) => r?.pending ? `${modelId} download started` : `${modelId} installed`);
  const remove = (modelId) => runAction(`delete-${modelId}`, () => deleteLocalLlmModel(selected, modelId), `${modelId} deleted`);

  return (
    <div className="space-y-4">
      {/* Backends — status + switch/migrate */}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-gray-300">Local LLM Backends</h2>
          <button onClick={loadStatus} disabled={loading} className="p-1.5 text-gray-400 hover:text-white transition-colors" title="Refresh" aria-label="Refresh local LLM status">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>

        {loading && !status ? (
          <BrailleSpinner text="Loading local LLM status" />
        ) : status ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {BACKENDS.map((b) => (
                <BackendCard
                  key={b.id} backend={b} status={status} isActive={status.backend === b.id}
                  busy={busy} actionInProgress={actionInProgress}
                  runAction={runAction} setConfirmAction={setConfirmAction}
                />
              ))}
            </div>

            {progressMsg && (
              <div className="flex items-center gap-2 text-sm text-port-accent bg-port-accent/10 border border-port-accent/20 rounded-lg px-3 py-2">
                <BrailleSpinner />
                {progressMsg}
              </div>
            )}

            {confirmAction && (
              <div className="bg-port-bg border border-port-warning/30 rounded-lg p-4 space-y-3">
                <p className="text-sm text-white">{confirmAction.label}</p>
                {confirmAction.detail && <p className="text-xs text-gray-400">{confirmAction.detail}</p>}
                <div className="flex items-center gap-2">
                  <button
                    onClick={confirmAction.action}
                    disabled={busy}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 bg-port-warning/20 hover:bg-port-warning/30 text-port-warning"
                  >
                    {busy ? <BrailleSpinner /> : <ArrowRightLeft size={14} />}
                    Confirm
                  </button>
                  <button onClick={() => setConfirmAction(null)} className="px-3 py-1.5 text-sm text-gray-400 hover:text-white transition-colors">
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-gray-500">Unable to load local LLM status</p>
        )}
      </div>

      {/* Models — backend picker + catalog/install + installed list */}
      <div className="bg-port-card border border-port-border rounded-xl p-4 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h2 className="text-sm font-medium text-gray-300">Models</h2>
          <div className="flex items-center gap-1.5">
            {BACKENDS.map((b) => (
              <button
                key={b.id}
                onClick={() => setSelected(b.id)}
                className={`px-2.5 py-1 text-xs rounded transition-colors ${selected === b.id ? 'bg-port-accent/20 text-port-accent' : 'bg-port-bg text-gray-400 hover:text-white'}`}
              >
                {b.label}
              </button>
            ))}
          </div>
        </div>

        {selectedData && !selectedData.available && (
          <p className="text-xs text-port-warning">
            {labelFor(selected)} isn't running — {selectedData.installed
              ? `start it to install or manage models${selected === 'ollama' ? ' (run \`ollama serve\`)' : ' (launch the app and enable the local server)'}.`
              : 'install it first (Settings → Local LLMs prompts at setup, or run `npm run setup:llm`).'}
          </p>
        )}
        {selectedData?.available && selectedData?.modelsError && (
          <p className="text-xs text-port-warning">
            Couldn't list {labelFor(selected)} models (showing what's available): {selectedData.modelsError}
          </p>
        )}

        {/* Free-text install + search */}
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="flex-1 flex items-center gap-2 bg-port-bg border border-port-border rounded-lg px-3">
            <Search size={14} className="text-gray-500" />
            <label htmlFor="llm-catalog-search" className="sr-only">{`Search the ${labelFor(selected)} model catalog`}</label>
            <input
              id="llm-catalog-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search the ${labelFor(selected)} catalog…`}
              className="flex-1 bg-transparent py-2 text-sm text-white placeholder-gray-600 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor="llm-manual-install" className="sr-only">{`Install a ${labelFor(selected)} model by id`}</label>
            <input
              id="llm-manual-install"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              placeholder={selected === 'ollama' ? 'pull by name e.g. llama3.2' : 'publisher/Model-GGUF'}
              className="flex-1 sm:w-56 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-port-accent"
            />
            <button
              onClick={() => { const id = manualId.trim(); if (id) { install(id); setManualId(''); } }}
              disabled={busy || !manualId.trim()}
              className="flex items-center gap-1.5 px-3 py-2 bg-port-accent/20 hover:bg-port-accent/30 text-port-accent text-sm font-medium rounded-lg disabled:opacity-50"
            >
              <Plus size={14} /> Install
            </button>
          </div>
        </div>

        {/* Catalog cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {catalog.map((m) => (
            <div key={m.id} className="flex items-start gap-3 bg-port-bg border border-port-border rounded-lg p-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{m.name} <span className="text-xs text-gray-500">· {m.params}</span></div>
                <div className="text-xs text-gray-500 truncate">{m.id}</div>
                <div className="text-xs text-gray-500 mt-0.5">{m.description}</div>
                <div className="text-[11px] text-gray-600 mt-0.5">{m.size} · {(m.capabilities || []).join(', ')}</div>
              </div>
              {m.installed ? (
                <span className="text-xs px-2 py-1 text-port-success shrink-0">Installed</span>
              ) : (
                <button
                  onClick={() => install(m.id)}
                  disabled={busy}
                  className="px-2.5 py-1 text-xs bg-port-accent/20 hover:bg-port-accent/30 text-port-accent rounded disabled:opacity-50 flex items-center gap-1 shrink-0"
                >
                  {actionInProgress === `install-${m.id}` ? <BrailleSpinner /> : <Download size={12} />}
                  Install
                </button>
              )}
            </div>
          ))}
          {catalog.length === 0 && (
            <p className="text-xs text-gray-500">No catalog matches{query ? ` for "${query}"` : ''}.</p>
          )}
        </div>

        {/* Installed models */}
        <div className="space-y-2 pt-2 border-t border-port-border/50">
          <h3 className="text-xs font-medium text-gray-400">Installed on {labelFor(selected)} ({installedModels.length})</h3>
          {installedModels.length === 0 ? (
            <p className="text-xs text-gray-500">No models installed yet.</p>
          ) : installedModels.map((m) => (
            <div key={m.id} className="flex items-center gap-3 bg-port-bg border border-port-border rounded-lg p-3">
              <div className="flex-1 min-w-0">
                <div className="text-sm text-white truncate">{m.name}</div>
                <div className="text-xs text-gray-500 truncate">
                  {[m.params, m.quantization, m.family].filter(Boolean).join(' · ')}
                </div>
              </div>
              {m.size != null && <span className="text-xs text-gray-400 shrink-0">{formatBytes(m.size)}</span>}
              <button
                onClick={() => remove(m.id)}
                disabled={busy}
                className="px-2.5 py-1 text-xs bg-port-error/20 hover:bg-port-error/40 text-port-error rounded disabled:opacity-50 flex items-center gap-1 shrink-0"
              >
                {actionInProgress === `delete-${m.id}` ? <BrailleSpinner /> : <Trash2 size={12} />}
                Delete
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default LocalLlmTab;
