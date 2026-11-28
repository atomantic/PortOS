import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { getVoiceRealtimeStatus, updateVoiceConfig } from '../../services/apiVoice';
import { startRealtimeCall } from '../../services/voiceRealtime';

const button = 'satphone-key inline-flex min-h-11 items-center justify-center rounded-lg border px-3 text-xs font-mono font-semibold uppercase tracking-wide disabled:opacity-50';
const MAX_CAPTIONS = 8;
export const SOPHON_INSTALL_COMMAND = 'git clone https://github.com/adventists-ai/sophon-realtime.git && cd sophon-realtime && SOPHON_HOME=~/.portos/sophon-mac bash mac/install.sh && cp mac/adapt.py ~/.portos/sophon-mac/app/';

/**
 * Realtime (speech-to-speech) Voice Call: a local full-duplex voice you can interrupt, which hands lookups and actions
 * to the regular Voice tools and speaks their result. Shows whether the model is installed, the on/off, size and
 * install-path settings, and call controls with live captions.
 */
export default function RealtimeCallPanel({ compact = false }) {
  const [status, setStatus] = useState(null);
  const [homeDraft, setHomeDraft] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [call, setCall] = useState({ phase: 'idle', error: '' });
  const [captions, setCaptions] = useState([]);
  const handle = useRef(null);
  // Bumped by hang-up and unmount, so a call still starting (mic prompt, worklet load) is stopped when it resolves.
  const attempt = useRef(0);
  const lastSavedHomeRef = useRef(null);
  const modelId = useId();
  const homeId = useId();

  const refresh = useCallback(async ({ syncHome = false } = {}) => {
    try {
      const next = await getVoiceRealtimeStatus({ silent: true });
      const nextHome = next?.home || '';
      const prevHome = lastSavedHomeRef.current;
      lastSavedHomeRef.current = nextHome;
      setStatus(next);
      setHomeDraft((draft) => (syncHome || prevHome === null || draft.trim() === prevHome ? nextHome : draft));
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => () => { attempt.current += 1; handle.current?.stop(); }, []);

  const caption = (kind, text) => {
    if (!text) return;
    setCaptions((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, kind, text }].slice(-MAX_CAPTIONS));
  };

  const save = async (patch) => {
    setSaving(true);
    try {
      await updateVoiceConfig({ realtime: patch }, { silent: true });
      await refresh({ syncHome: Object.hasOwn(patch, 'home') });
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    setCaptions([]);
    setCall({ phase: 'loading', error: '' });
    const mine = ++attempt.current;
    try {
      const started = await startRealtimeCall({
        onState: (s) => {
          if (attempt.current !== mine) return;
          if (s?.error) {
            attempt.current += 1;
            setCall({ phase: 'idle', error: s.error });
            handle.current?.stop();
            handle.current = null;
            return;
          }
          if (s?.loading) setCall({ phase: 'loading', error: '' });
          else if (s?.active) setCall({ phase: 'live', error: '' });
          else if (s?.reason === 'sidecar-closed') {
            attempt.current += 1;
            setCall({ phase: 'idle', error: 'The realtime voice stopped.' });
            handle.current?.stop();
            handle.current = null;
          }
        },
        onReply: ({ text, cancelled }) => { if (attempt.current === mine) caption('assistant', cancelled ? `${text} (interrupted)` : text); },
        onDelegate: ({ task }) => { if (attempt.current === mine) caption('task', task); },
        onResult: ({ text }) => { if (attempt.current === mine) caption('result', text); },
      });
      if (attempt.current !== mine) { started.stop(); return; }
      handle.current = started;
    } catch (err) {
      if (attempt.current === mine) setCall({ phase: 'idle', error: err.message });
    }
  };

  const interrupt = () => {
    handle.current?.interrupt();
  };

  const hangUp = () => {
    attempt.current += 1;
    handle.current?.stop();
    handle.current = null;
    setCall({ phase: 'idle', error: '' });
  };

  const live = call.phase === 'live';
  const busy = live || call.phase === 'loading';
  const trimmedHome = homeDraft.trim();
  const homeDirty = Boolean(status) && trimmedHome !== (status.home || '');
  const ledTone = live ? 'bg-port-success shadow-[0_0_6px_rgb(var(--port-success)/0.85)]'
    : call.phase === 'loading' ? 'bg-port-warning animate-pulse' : 'bg-port-text-muted/50';
  const missing = status ? Object.entries(status.parts || {}).filter(([, ok]) => !ok).map(([part]) => part) : [];

  const saveHome = (e) => {
    e.preventDefault();
    if (!trimmedHome || !homeDirty || saving || busy) return;
    save({ home: trimmedHome });
  };

  return (
    <section aria-label="Realtime voice" className={`space-y-3 rounded-xl border border-port-border bg-port-card text-port-text ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${ledTone}`} />
          <h2 className="font-mono text-xs font-semibold uppercase tracking-wider">
            <span aria-live="polite">
              {live ? 'Realtime call live' : call.phase === 'loading' ? 'Loading realtime voice…' : 'Realtime voice'}
            </span>
          </h2>
        </div>
        {status?.installed && status.enabled && status.voiceEnabled !== false && (
          <div className="flex flex-wrap items-center gap-2">
            {live && <button type="button" className={button} onClick={interrupt}>Interrupt</button>}
            {busy
              ? <button type="button" className={button} onClick={hangUp}>Hang up</button>
              : <button type="button" className={button} disabled={saving || homeDirty} onClick={start}>Start realtime call</button>}
          </div>
        )}
      </div>
      <p className="text-xs text-port-text-muted">
        Speech to speech: you can interrupt it, and it hands lookups and actions to your Voice tools. The first call loads the model (about a minute).
      </p>
      {status?.installed && status.enabled && status.voiceEnabled === false && (
        <p role="status" className="text-xs text-port-text-muted">Turn on Voice mode in Voice settings to start a realtime call.</p>
      )}
      {loadError && <p role="alert" className="text-xs text-port-error-text">{loadError}</p>}
      {!status && !loadError && <p role="status" className="text-xs">Checking realtime voice…</p>}
      {status && (
        <div className="space-y-2.5 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            {status.installed && (
              <label className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={status.enabled} disabled={saving || busy} onChange={(e) => save({ enabled: e.target.checked })} />
                Enable realtime calls
              </label>
            )}
            <div className="inline-flex items-center gap-1.5">
              <label htmlFor={modelId}>Model</label>
              <select id={modelId} value={status.size} disabled={saving || busy} onChange={(e) => save({ size: e.target.value })}
                className="min-h-9 rounded-md border border-port-border bg-port-bg px-1.5 font-mono text-xs">
                <option value="32B">32B (smarter, ~24 GB)</option>
                <option value="4B">4B (fastest, ~9 GB)</option>
              </select>
            </div>
          </div>
          <form onSubmit={saveHome} className="flex flex-wrap items-center gap-2 min-w-0">
            <label htmlFor={homeId} className="shrink-0 text-port-text-muted">Install path</label>
            <input
              id={homeId}
              type="text"
              value={homeDraft}
              disabled={saving || busy}
              onChange={(e) => setHomeDraft(e.target.value)}
              className="min-h-9 min-w-[12rem] flex-1 rounded-md border border-port-border bg-port-bg px-2 font-mono text-xs text-port-text"
            />
            <button type="submit" className={button} disabled={saving || busy || !homeDirty || !trimmedHome}>Save path</button>
          </form>
        </div>
      )}
      {status && !status.installed && (
        <div className="space-y-1.5 text-xs">
          <p>Not installed at <code className="break-all">{status.home}</code> (missing {missing.join(', ')}). Install the Sophon-Realtime Mac build in a terminal, then refresh:</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg border border-port-border bg-port-bg p-2 font-mono text-[11px]">{SOPHON_INSTALL_COMMAND}</pre>
          <button type="button" className={button} onClick={refresh}>Refresh</button>
        </div>
      )}
      {call.error && <p role="alert" className="text-xs text-port-error-text">{call.error}</p>}
      <div
        role="log"
        aria-live="polite"
        aria-label="Realtime captions"
        className={captions.length > 0 ? undefined : 'sr-only'}
      >
        {captions.length > 0 && (
          <ul className="space-y-1 text-xs">
            {captions.map((c) => (
              <li key={c.id} className={c.kind === 'assistant' ? '' : 'text-port-text-muted'}>
                {c.kind === 'task' ? `Looking up: ${c.text}` : c.kind === 'result' ? `Result: ${c.text}` : c.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
