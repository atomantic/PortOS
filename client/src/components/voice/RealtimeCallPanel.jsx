import { useCallback, useEffect, useRef, useState } from 'react';
import { getVoiceRealtimeStatus, updateVoiceConfig } from '../../services/apiVoice';
import { startRealtimeCall } from '../../services/voiceRealtime';

const button = 'satphone-key inline-flex min-h-11 items-center justify-center rounded-lg border px-3 text-xs font-mono font-semibold uppercase tracking-wide disabled:opacity-50';
const MAX_CAPTIONS = 8;
export const SOPHON_INSTALL_COMMAND = 'git clone https://github.com/adventists-ai/sophon-realtime.git && cd sophon-realtime && SOPHON_HOME=~/.portos/sophon-mac bash mac/install.sh && cp mac/adapt.py ~/.portos/sophon-mac/app/';

/**
 * Realtime (speech-to-speech) Voice Call: a local full-duplex voice you can interrupt, which hands lookups and actions
 * to the regular Voice tools and speaks their result. Shows whether the model is installed, the on/off and size
 * settings, and a call button with live captions.
 */
export default function RealtimeCallPanel({ compact = false }) {
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [call, setCall] = useState({ phase: 'idle', error: '' });
  const [captions, setCaptions] = useState([]);
  const handle = useRef(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getVoiceRealtimeStatus({ silent: true }));
      setLoadError('');
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => () => handle.current?.stop(), []);

  const caption = (kind, text) => {
    if (!text) return;
    setCaptions((prev) => [...prev, { id: `${Date.now()}-${Math.random()}`, kind, text }].slice(-MAX_CAPTIONS));
  };

  const save = async (patch) => {
    setSaving(true);
    try {
      await updateVoiceConfig({ realtime: patch });
      await refresh();
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const start = async () => {
    setCaptions([]);
    setCall({ phase: 'loading', error: '' });
    try {
      handle.current = await startRealtimeCall({
        onState: (s) => {
          if (s?.error) { setCall({ phase: 'idle', error: s.error }); handle.current?.stop(); handle.current = null; return; }
          if (s?.loading) setCall({ phase: 'loading', error: '' });
          else if (s?.active) setCall({ phase: 'live', error: '' });
          else if (s?.reason === 'sidecar-closed') { setCall({ phase: 'idle', error: 'The realtime voice stopped.' }); handle.current?.stop(); handle.current = null; }
        },
        onReply: ({ text, cancelled }) => caption('assistant', cancelled ? `${text} (interrupted)` : text),
        onDelegate: ({ task }) => caption('task', task),
        onResult: ({ text }) => caption('result', text),
      });
    } catch (err) {
      setCall({ phase: 'idle', error: err.message });
    }
  };

  const hangUp = () => {
    handle.current?.stop();
    handle.current = null;
    setCall({ phase: 'idle', error: '' });
  };

  const live = call.phase === 'live';
  const ledTone = live ? 'bg-port-success shadow-[0_0_6px_rgb(var(--port-success)/0.85)]'
    : call.phase === 'loading' ? 'bg-port-warning animate-pulse' : 'bg-port-text-muted/50';
  const missing = status ? Object.entries(status.parts || {}).filter(([, ok]) => !ok).map(([part]) => part) : [];

  return (
    <section aria-label="Realtime voice" className={`space-y-3 rounded-xl border border-port-border bg-port-card text-port-text ${compact ? 'p-3' : 'p-4'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${ledTone}`} />
          <h3 className="font-mono text-xs font-semibold uppercase tracking-wider">
            {live ? 'Realtime call live' : call.phase === 'loading' ? 'Loading realtime voice…' : 'Realtime voice'}
          </h3>
        </div>
        {status?.installed && status.enabled && (live || call.phase === 'loading'
          ? <button type="button" className={button} onClick={hangUp}>Hang up</button>
          : <button type="button" className={button} onClick={start}>Start realtime call</button>)}
      </div>
      <p className="text-xs text-port-text-muted">
        Speech to speech: you can interrupt it, and it hands lookups and actions to your Voice tools. The first call loads the model (about a minute).
      </p>
      {loadError && <p role="alert" className="text-xs text-port-error-text">{loadError}</p>}
      {!status && !loadError && <p role="status" className="text-xs">Checking realtime voice…</p>}
      {status && !status.installed && (
        <div className="space-y-1.5 text-xs">
          <p>Not installed at <code className="break-all">{status.home}</code> (missing {missing.join(', ')}). Install the Sophon-Realtime Mac build in a terminal, then refresh:</p>
          <pre className="whitespace-pre-wrap break-all rounded-lg border border-port-border bg-port-bg p-2 font-mono text-[11px]">{SOPHON_INSTALL_COMMAND}</pre>
          <button type="button" className={button} onClick={refresh}>Refresh</button>
        </div>
      )}
      {status?.installed && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <label className="inline-flex items-center gap-1.5">
            <input type="checkbox" checked={status.enabled} disabled={saving || live} onChange={(e) => save({ enabled: e.target.checked })} />
            Enable realtime calls
          </label>
          <label className="inline-flex items-center gap-1.5">
            Model
            <select value={status.size} disabled={saving || live} onChange={(e) => save({ size: e.target.value })}
              className="min-h-9 rounded-md border border-port-border bg-port-bg px-1.5 font-mono text-xs">
              <option value="32B">32B (smarter, ~24 GB)</option>
              <option value="4B">4B (fastest, ~9 GB)</option>
            </select>
          </label>
        </div>
      )}
      {call.error && <p role="alert" className="text-xs text-port-error-text">{call.error}</p>}
      {captions.length > 0 && (
        <ul aria-label="Realtime captions" className="space-y-1 text-xs">
          {captions.map((c) => (
            <li key={c.id} className={c.kind === 'assistant' ? '' : 'text-port-text-muted'}>
              {c.kind === 'task' ? `Looking up: ${c.text}` : c.kind === 'result' ? `Result: ${c.text}` : c.text}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
