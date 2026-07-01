/**
 * ProcessLogModal — a self-contained viewer for a PM2 process's system log.
 *
 * Built so an operator who doesn't know where the system logs live can open the
 * relevant log straight from wherever an error surfaced (e.g. a failed AI run in
 * RunsHistoryPage). Fetches a static tail via `getProcessLogs` (not the live SSE
 * stream — a past failure's context is already written), with a process picker,
 * a tail-length selector, and a manual refresh.
 *
 * Fully generic: the caller passes the process to open (`processName`) — no run
 * or domain coupling lives here.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, X } from 'lucide-react';
import Modal from './Modal';
import BrailleSpinner from '../BrailleSpinner';
import * as api from '../../services/api';

// Keep the default tailLines (200) present here so the controlled <select>
// renders a matching option on open rather than a mismatched first entry.
const TAIL_OPTIONS = [100, 200, 500, 1000, 2000];

export default function ProcessLogModal({ open, onClose, processName, title = 'System Logs' }) {
  const [processes, setProcesses] = useState([]);
  const [selected, setSelected] = useState(processName || '');
  const [tailLines, setTailLines] = useState(200);
  const [logs, setLogs] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Monotonic request id — a superseded (or post-close) fetch is a no-op so a
  // slow response can't clobber the newer process's logs.
  const reqIdRef = useRef(0);

  // Seed the selected process from the caller's hint whenever the modal opens,
  // and drop any prior run's logs so they never flash under the new title.
  useEffect(() => {
    if (!open) return;
    setSelected(processName || '');
    setLogs('');
    setError('');
  }, [open, processName]);

  // Load the PM2 process picker options once per open (static across a session).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api.getProcessesList({ silent: true })
      .then((list) => { if (!cancelled) setProcesses(Array.isArray(list) ? list : []); })
      .catch(() => { if (!cancelled) setProcesses([]); });
    return () => { cancelled = true; };
  }, [open]);

  const loadLogs = useCallback(async () => {
    if (!selected) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError('');
    // Clear the prior logs so the in-flight fetch shows the spinner instead of
    // the previous process/tail's output (which could sit under a new title).
    setLogs('');
    const res = await api.getProcessLogs(selected, tailLines).catch((err) => {
      if (reqId === reqIdRef.current) setError(err?.message || 'Failed to load logs');
      return null;
    });
    if (reqId !== reqIdRef.current) return; // superseded by a newer request
    if (res) setLogs(res.logs || '');
    setLoading(false);
  }, [selected, tailLines]);

  // Fetch whenever the modal is open and the process / tail length changes.
  // The cleanup bumps the request id so an in-flight fetch is invalidated when
  // the deps change or the modal closes.
  useEffect(() => {
    if (!open || !selected) return;
    loadLogs();
    return () => { reqIdRef.current++; };
  }, [open, selected, loadLogs]);

  return (
    <Modal open={open} onClose={onClose} size="3xl" align="top" ariaLabel={title}>
      <div className="bg-port-card border border-port-border rounded-xl overflow-hidden flex flex-col max-h-[80vh]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-port-border">
          <span className="text-base sm:text-lg font-medium text-white">{title}</span>
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-1.5">
              <label htmlFor="log-process" className="text-xs text-gray-500">Process</label>
              <select
                id="log-process"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white max-w-[10rem]"
              >
                {/* Keep the caller's hinted process selectable even if PM2 isn't
                    reporting it (e.g. dev server not under PM2) so the fetch can
                    still surface a helpful error. */}
                {selected && !processes.some((p) => p.name === selected) && (
                  <option value={selected}>{selected}</option>
                )}
                {processes.map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-1.5">
              <label htmlFor="log-tail" className="text-xs text-gray-500">Tail</label>
              <select
                id="log-tail"
                value={tailLines}
                onChange={(e) => setTailLines(Number(e.target.value))}
                className="px-2 py-1 text-xs bg-port-bg border border-port-border rounded text-white"
              >
                {TAIL_OPTIONS.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <button
              onClick={loadLogs}
              disabled={loading || !selected}
              className="p-1.5 text-gray-400 hover:text-white transition-colors disabled:opacity-50"
              title="Refresh logs"
              aria-label="Refresh logs"
            >
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-white transition-colors"
              title="Close"
              aria-label="Close logs"
            >
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-auto bg-port-bg p-3 sm:p-4 min-h-[16rem]">
          {loading && !logs ? (
            <BrailleSpinner text="Loading logs" />
          ) : error ? (
            <div className="text-sm text-port-error font-mono">{error}</div>
          ) : logs ? (
            <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all">{logs}</pre>
          ) : (
            <div className="text-sm text-gray-500">No log output.</div>
          )}
        </div>
      </div>
    </Modal>
  );
}
