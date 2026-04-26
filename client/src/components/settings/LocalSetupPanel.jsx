import { useState, useEffect, useCallback, useRef } from 'react';
import { CheckCircle2, XCircle, Wand2, RefreshCw, Terminal, AlertTriangle, Box } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';

export default function LocalSetupPanel({ pythonPath, onPythonPathChange }) {
  const [detecting, setDetecting] = useState(false);
  const [check, setCheck] = useState(null); // { required, installed, missing, missingPip }
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState([]);
  const [creatingVenv, setCreatingVenv] = useState(false);
  const logRef = useRef(null);
  const installEsRef = useRef(null);

  // Closing the install EventSource on unmount stops setInstalling /
  // setInstallLog calls firing on a torn-down component if the user
  // navigates away mid pip-install.
  useEffect(() => () => installEsRef.current?.close(), []);

  const refreshCheck = useCallback(async (path) => {
    if (!path) { setCheck(null); return; }
    setChecking(true);
    try {
      const res = await fetch(`/api/image-gen/setup/check?pythonPath=${encodeURIComponent(path)}`);
      if (!res.ok) { setCheck(null); return; }
      setCheck(await res.json());
    } catch {
      // Server down / offline — clear the check rather than getting stuck
      // in a perpetual "Checking…" state.
      setCheck(null);
    } finally {
      setChecking(false);
    }
  }, []);

  // Debounce typing in the path input so we don't spawn a python subprocess
  // per keystroke. Settled value triggers /setup/check.
  useEffect(() => {
    const t = setTimeout(() => refreshCheck(pythonPath), 400);
    return () => clearTimeout(t);
  }, [pythonPath, refreshCheck]);

  // Auto-scroll install log to bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [installLog]);

  const handleDetect = async () => {
    setDetecting(true);
    const res = await fetch('/api/image-gen/setup/python');
    setDetecting(false);
    if (!res.ok) { toast.error('Detection failed'); return; }
    const { path } = await res.json();
    if (path) {
      onPythonPathChange(path);
      toast.success(`Detected ${path}`);
    } else {
      toast.error('No Python 3 found on this system');
    }
  };

  const handleInstall = () => {
    if (!check?.missingPip?.length) return;
    setInstalling(true);
    setInstallLog([]);

    const url = `/api/image-gen/setup/install?pythonPath=${encodeURIComponent(pythonPath)}&packages=${encodeURIComponent(check.missingPip.join(','))}`;
    const es = new EventSource(url);
    installEsRef.current = es;

    es.onmessage = (e) => {
      const event = (() => { try { return JSON.parse(e.data); } catch { return null; } })();
      if (!event) return;
      setInstallLog(prev => [...prev.slice(-200), event]);
      if (event.type === 'complete') {
        es.close();
        installEsRef.current = null;
        setInstalling(false);
        toast.success('Packages installed');
        refreshCheck(pythonPath);
      } else if (event.type === 'error') {
        es.close();
        installEsRef.current = null;
        setInstalling(false);
        toast.error(event.message);
        refreshCheck(pythonPath);
      }
    };

    es.onerror = () => {
      es.close();
      installEsRef.current = null;
      setInstalling(false);
    };
  };

  const handleCreateVenv = async () => {
    setCreatingVenv(true);
    const res = await fetch('/api/image-gen/setup/create-venv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    setCreatingVenv(false);
    if (!res.ok) {
      const json = await res.json().catch(() => ({}));
      toast.error(json.error || 'Venv creation failed');
      return;
    }
    const { pythonPath: venvPython } = await res.json();
    onPythonPathChange(venvPython);
    toast.success(`Created venv at ${venvPython}`);
  };

  return (
    <div className="space-y-4">
      {/* Python path + detect */}
      <div className="flex items-center gap-2">
        <input
          type="text"
          value={pythonPath || ''}
          onChange={(e) => onPythonPathChange(e.target.value)}
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
                  <div className="flex items-start gap-2 text-xs text-port-warning bg-port-warning/10 border border-port-warning/30 rounded p-2">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <div>
                      This Python is <strong>externally managed</strong> (PEP 668) — pip can't install into it.
                      Create a PortOS-owned venv to install packages safely without touching your system Python.
                    </div>
                  </div>
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
                  ref={logRef}
                  className="mt-3 max-h-48 overflow-y-auto text-[11px] font-mono text-gray-400 bg-black/40 border border-port-border rounded p-2 whitespace-pre-wrap"
                >
                  {installLog.map((e, i) => (
                    <div key={i} className={e.type === 'error' ? 'text-port-error' : e.type === 'complete' ? 'text-port-success' : ''}>
                      {e.message}
                    </div>
                  ))}
                </pre>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
