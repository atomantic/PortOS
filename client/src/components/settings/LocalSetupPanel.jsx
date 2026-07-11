import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle2, XCircle, Wand2, RefreshCw, Terminal, AlertTriangle, Box, Cpu } from 'lucide-react';
import toast from '../ui/Toast';
import Banner from '../ui/Banner';
import BrailleSpinner from '../BrailleSpinner';
import { usePrevious } from '../../hooks/usePrevious.js';
import { useInstallStream } from '../../hooks/useInstallStream.js';
import useMounted from '../../hooks/useMounted.js';

export default function LocalSetupPanel({ pythonPath, onPythonPathChange, onPackagesChanged }) {
  const [detecting, setDetecting] = useState(false);
  const [check, setCheck] = useState(null); // { required, installed, missing, missingPip }
  const [checking, setChecking] = useState(false);
  // Pip-install SSE URL — null until the user clicks Install. The `attempt`
  // counter makes a retry after a failed install produce a fresh URL, so the
  // stream hook re-subscribes even when the package list is unchanged.
  const [installUrl, setInstallUrl] = useState(null);
  const installAttemptRef = useRef(0);
  const [creatingVenv, setCreatingVenv] = useState(false);
  // Decouple the input from the parent's persisted path. The VideoGen
  // consumer saves on every onPythonPathChange, so wiring the input to the
  // prop directly fires a settings PATCH + ~1-2s status re-probe per
  // keystroke. Typed edits commit on debounce/blur; programmatic updates
  // (Detect, Switch-to-arm64, Create-venv) still call onPythonPathChange
  // directly so they take effect immediately.
  const [draftPath, setDraftPath] = useState(pythonPath || '');
  const commitTimerRef = useRef(null);
  // Track mount + the latest in-flight /setup/check abort controller so a fetch
  // that's still resolving after unmount (or superseded by a newer check)
  // neither sets state on a dead component nor wastes the round-trip.
  const mountedRef = useMounted();
  const checkAbortRef = useRef(null);
  useEffect(() => () => checkAbortRef.current?.abort(), []);
  useEffect(() => { setDraftPath(pythonPath || ''); }, [pythonPath]);
  useEffect(() => () => clearTimeout(commitTimerRef.current), []);
  const commitDraft = (value) => {
    clearTimeout(commitTimerRef.current);
    if (value !== (pythonPath || '')) onPythonPathChange(value);
  };
  const handleDraftChange = (value) => {
    setDraftPath(value);
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => commitDraft(value), 800);
  };

  const refreshCheck = useCallback(async (path) => {
    // Abort any prior in-flight check first — even when the path was cleared —
    // so a stale response can't resolve and clobber state for a path that's no
    // longer selected, and so the fetch is dropped on unmount.
    checkAbortRef.current?.abort();
    checkAbortRef.current = null;
    if (!path) { setCheck(null); setChecking(false); return; }
    const controller = new AbortController();
    checkAbortRef.current = controller;
    setChecking(true);
    try {
      const res = await fetch(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(path)}`, { signal: controller.signal });
      if (!mountedRef.current) return;
      if (!res.ok) { setCheck(null); return; }
      setCheck(await res.json());
    } catch (err) {
      // Aborted (unmount or superseded) — leave state alone.
      if (err?.name === 'AbortError') return;
      // Server down / offline — clear the check rather than getting stuck
      // in a perpetual "Checking…" state.
      if (mountedRef.current) setCheck(null);
    } finally {
      // Only settle the spinner for the current request; an aborted/superseded
      // call must not flip a newer in-flight check's spinner off.
      if (mountedRef.current && checkAbortRef.current === controller) setChecking(false);
    }
  }, []);

  // Debounce typing in the path input so we don't spawn a python subprocess
  // per keystroke. Settled value triggers /setup/check.
  useEffect(() => {
    const t = setTimeout(() => refreshCheck(pythonPath), 400);
    return () => clearTimeout(t);
  }, [pythonPath, refreshCheck]);

  // The shared install-stream hook owns the EventSource lifecycle, log
  // accumulation (capped at the same 200 lines as before), connection-lost
  // handling, unmount teardown, and auto-scroll.
  const {
    logs: installLog,
    done: installDone,
    error: installError,
    streamStarted: installStarted,
    logsEndRef,
  } = useInstallStream(installUrl, {
    maxLogLines: 200,
    onComplete: () => {
      toast.success('Packages installed');
      refreshCheck(pythonPath);
    },
  });
  const installing = installStarted && !installDone && !installError;

  // Surface an install failure (error frame or dropped connection) once, then
  // re-check so the package list reflects whatever did get installed.
  const prevInstallError = usePrevious(installError, null);
  useEffect(() => {
    if (installError && !prevInstallError) {
      toast.error(installError);
      refreshCheck(pythonPath);
    }
  }, [installError, prevInstallError, refreshCheck, pythonPath]);

  // Notify the parent whenever local check transitions from "had missing
  // packages" to "all installed" — covers manual refresh, terminal installs,
  // and the SSE-complete path. Without this, parent state (e.g. VideoGen's
  // status pill) stays stale until the user manually clicks its own refresh.
  const hadMissing = !!check && Array.isArray(check.missing) && check.missing.length > 0;
  const allInstalled = !!check && Array.isArray(check.missing) && check.missing.length === 0;
  const prevHadMissing = usePrevious(hadMissing, false);
  useEffect(() => {
    if (allInstalled && prevHadMissing) onPackagesChanged?.();
  }, [allInstalled, prevHadMissing, onPackagesChanged]);

  const handleDetect = async () => {
    setDetecting(true);
    try {
      const res = await fetch('/api/image-gen/setup/python');
      if (!res.ok) { toast.error('Detection failed'); return; }
      const { path } = await res.json();
      if (path) {
        onPythonPathChange(path);
        toast.success(`Detected ${path}`);
      } else {
        toast.error('No Python 3 found on this system');
      }
    } catch {
      toast.error('Detection failed');
    } finally {
      // Always clear detecting state — without this, a fetch reject would
      // leave the button stuck disabled forever.
      setDetecting(false);
    }
  };

  const handleInstall = () => {
    if (!check?.missingPip?.length) return;
    installAttemptRef.current += 1;
    setInstallUrl(`/api/image-gen/setup/install?pythonPath=${encodeURIComponent(pythonPath)}&packages=${encodeURIComponent(check.missingPip.join(','))}&attempt=${installAttemptRef.current}`);
  };

  const handleCreateVenv = async () => {
    setCreatingVenv(true);
    try {
      const res = await fetch('/api/image-gen/setup/create-venv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        toast.error(json.error || 'Venv creation failed');
        return;
      }
      const { pythonPath: venvPython } = await res.json();
      onPythonPathChange(venvPython);
      toast.success(`Created venv at ${venvPython}`);
    } catch {
      toast.error('Failed to create venv');
    } finally {
      // Always clear so a fetch reject doesn't leave the button disabled.
      setCreatingVenv(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Python path + detect */}
      <label htmlFor="python-path" className="sr-only">Python path</label>
      <div className="flex items-center gap-2">
        <input
          id="python-path"
          type="text"
          value={draftPath}
          onChange={(e) => handleDraftChange(e.target.value)}
          onBlur={() => commitDraft(draftPath)}
          className="flex-1 bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-port-accent"
          placeholder="/usr/local/bin/python3"
        />
        <button
          type="button"
          onClick={handleDetect}
          disabled={detecting}
          className="flex items-center gap-2 px-3 py-2 text-sm text-gray-300 hover:text-white border border-port-border rounded-lg hover:bg-port-border/50 min-h-[40px] disabled:opacity-50"
          title="Auto-detect Python 3"
        >
          {detecting ? <BrailleSpinner /> : <Wand2 size={14} />} Detect
        </button>
      </div>

      {/* Required packages */}
      {pythonPath && (
        <div className="border border-port-border rounded-lg p-3 bg-port-bg/50">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-medium text-gray-300">Required packages</h4>
            <button
              type="button"
              onClick={() => refreshCheck(pythonPath)}
              disabled={checking}
              className="p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50 disabled:opacity-50"
              title="Re-check"
            >
              <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
            </button>
          </div>
          {!check ? (
            <p className="text-xs text-gray-500">{checking ? 'Checking…' : 'Set a Python path to check installed packages.'}</p>
          ) : (
            <>
              {check.archMismatch && (
                <Banner icon={Cpu} className="mb-3">
                  <div>
                    This Python reports <code>{check.interpreterArch}</code> but your Mac is <code>{check.hostArch}</code>.
                    <code>mlx</code> ships arm64-only wheels — installing it here will fail.
                  </div>
                  {check.suggestedArm64Python && (
                    <button
                      type="button"
                      onClick={() => onPythonPathChange(check.suggestedArm64Python)}
                      className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 text-xs bg-port-accent hover:bg-port-accent/80 text-white rounded"
                    >
                      <Wand2 size={12} /> Switch to {check.suggestedArm64Python}
                    </button>
                  )}
                </Banner>
              )}
              <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs mb-3">
                {check.required.map(pkg => {
                  const ok = check.installed.includes(pkg);
                  return (
                    <li key={pkg} className="flex items-center gap-2">
                      {ok
                        ? <CheckCircle2 size={14} className="text-port-success shrink-0" />
                        : <XCircle size={14} className="text-port-error shrink-0" />}
                      <code className={ok ? 'text-gray-300' : 'text-port-error'}>{pkg}</code>
                    </li>
                  );
                })}
              </ul>
              {check.externallyManaged && check.missing.length > 0 ? (
                <div className="space-y-2">
                  <Banner icon={AlertTriangle}>
                    <div>
                      This Python is <strong>externally managed</strong> (PEP 668) — pip can't install into it.
                      Create a PortOS-owned venv to install packages safely without touching your system Python.
                    </div>
                  </Banner>
                  <button
                    type="button"
                    onClick={handleCreateVenv}
                    disabled={creatingVenv}
                    className="flex items-center gap-2 px-3 py-2 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg disabled:opacity-50 min-h-[40px]"
                  >
                    {creatingVenv ? <BrailleSpinner /> : <Box size={14} />}
                    {creatingVenv ? 'Creating venv…' : 'Create PortOS venv'}
                  </button>
                </div>
              ) : check.missing.length > 0 ? (
                <button
                  type="button"
                  onClick={handleInstall}
                  disabled={installing}
                  className="flex items-center gap-2 px-3 py-2 text-sm bg-port-accent hover:bg-port-accent/80 text-white rounded-lg disabled:opacity-50 min-h-[40px]"
                >
                  {installing ? <BrailleSpinner /> : <Terminal size={14} />}
                  {installing ? 'Installing…' : `Install ${check.missing.length} missing package${check.missing.length === 1 ? '' : 's'}`}
                </button>
              ) : (
                <p className="text-xs text-port-success flex items-center gap-2">
                  <CheckCircle2 size={14} /> All required packages installed.
                </p>
              )}
              {(installing || installLog.length > 0) && (
                <pre
                  className="mt-3 max-h-48 overflow-y-auto text-[11px] font-mono text-gray-400 bg-black/40 border border-port-border rounded p-2 whitespace-pre-wrap"
                >
                  {installLog.map((e, i) => (
                    <div key={i} className={e.kind === 'error' ? 'text-port-error' : e.kind === 'success' ? 'text-port-success' : ''}>
                      {e.text}
                    </div>
                  ))}
                  <div ref={logsEndRef} />
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
