// Panel that surfaces what's currently resident in unified memory and lets
// the user evict it. The motivating workflow: "I want to render with FLUX.2
// 9B bf16 (~36 GB) — what's holding memory right now that I can free?"
//
// Sources of residency this panel covers:
//   - Ollama models (multiple can be loaded simultaneously) → /api/local-llm/loaded
//   - Whisper STT (PM2 process `portos-whisper`) → /api/voice/status + /api/voice/whisper
//   - Kokoro TTS (in-process kokoro-js) → /api/voice/tts/status + /api/voice/tts/unload
//
// Things NOT covered here on purpose:
//   - Gemma text encoder for LTX video — only loaded inside the render subprocess, not resident
//   - Piper TTS — spawned per-synthesis, no persistent process
//   - Browser / Codex / Claude Code workers — managed elsewhere, not memory-pressure relevant
//
// Polls every 5s while mounted. The component owns the toast layer via
// useAsyncAction (for explicit user actions) and the per-call `.catch()`
// fallbacks in `refresh()` (for poll failures, which must NOT toast — the
// panel would otherwise spam an error toast every 5s during a transient
// Ollama outage). Every API helper is called with `{ silent: true }` so
// apiCore's default toast doesn't fire underneath; per the CLAUDE.md
// "Silent vs. toasting API requests" rule, custom catch ⇒ silent: true.

import { useState, useEffect, useCallback } from 'react';
import { Cpu, Mic, Volume2, Trash2, Power, PowerOff, RefreshCw, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import useMounted from '../../hooks/useMounted.js';
import { formatBytes } from '../../utils/formatters';
import { getLoadedLlmModels, unloadOllamaModel } from '../../services/apiLocalLlm.js';
import { getTtsStatus, unloadKokoroTts, controlWhisper, getVoiceStatus } from '../../services/apiVoice.js';

const SILENT = { silent: true };

const POLL_MS = 5000;

const btnClass = 'flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded transition-colors disabled:opacity-50';

function Row({ icon: Icon, title, subtitle, status, action, danger }) {
  return (
    <div className="flex items-center gap-3 py-2 px-3 border-b border-port-border/50 last:border-b-0">
      <Icon className={`w-4 h-4 ${danger ? 'text-port-warning' : 'text-gray-400'} shrink-0`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-gray-200 truncate">{title}</div>
        {subtitle ? <div className="text-xs text-gray-500 truncate">{subtitle}</div> : null}
      </div>
      <div className="text-xs text-gray-400 mr-2 shrink-0">{status}</div>
      {action}
    </div>
  );
}

export default function MemoryManagement() {
  const [loadedOllama, setLoadedOllama] = useState([]);
  const [ttsState, setTtsState] = useState({ state: 'lazy', loadedKey: null });
  const [whisperRunning, setWhisperRunning] = useState(false);
  const [sttEngine, setSttEngine] = useState('whisper');
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState(0);
  // Guards the polled setState calls — a late /voice/status response that
  // resolves after unmount would otherwise call setState on a dead tree.
  // useMounted resets the ref to true on every mount so React 18 StrictMode's
  // mount→cleanup→remount cycle doesn't leave it permanently false (which
  // would otherwise keep the panel stuck on "Loading memory status…" in dev).
  const mountedRef = useMounted();

  // Returns the fresh snapshot so callers (notably freeAll) can act on the
  // values without waiting for React's async setState to flush — reading
  // component state immediately after `await refresh()` would still see
  // the prior poll's snapshot.
  const refresh = useCallback(async () => {
    const [llm, tts, voice] = await Promise.all([
      getLoadedLlmModels(SILENT).catch(() => ({ ollama: [] })),
      getTtsStatus(SILENT).catch(() => ({ kokoro: { state: 'lazy', loadedKey: null } })),
      getVoiceStatus(SILENT).catch(() => null),
    ]);
    const snapshot = {
      loadedOllama: Array.isArray(llm?.ollama) ? llm.ollama : [],
      ttsState: tts?.kokoro || { state: 'lazy', loadedKey: null },
      // voice.services.whisper.ok is the "PM2 process responsive" probe in
      // checkAll(). When the service block is missing (status fetch failed)
      // we default to "not running" — false negatives just mean the Stop
      // button briefly hides, which the next poll corrects.
      whisperRunning: Boolean(voice?.services?.whisper?.ok),
      sttEngine: voice?.sttEngine || 'whisper',
    };
    if (!mountedRef.current) return snapshot;
    setLoadedOllama(snapshot.loadedOllama);
    setTtsState(snapshot.ttsState);
    setWhisperRunning(snapshot.whisperRunning);
    setSttEngine(snapshot.sttEngine);
    setLoading(false);
    setLastFetched(Date.now());
    return snapshot;
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const [unloadModel, unloadingModel] = useAsyncAction(async (modelId) => {
    await unloadOllamaModel(modelId, SILENT);
    toast.success(`Unloaded ${modelId}`);
    await refresh();
  });
  const [unloadKokoro, unloadingKokoro] = useAsyncAction(async () => {
    const result = await unloadKokoroTts(SILENT);
    toast.success(result?.unloaded ? 'Kokoro TTS unloaded' : 'Kokoro was not loaded');
    await refresh();
  });
  const [stopWhisper, stoppingWhisper] = useAsyncAction(async () => {
    await controlWhisper('stop', SILENT);
    toast.success('Whisper stopped');
    await refresh();
  });
  const [startWhisper, startingWhisper] = useAsyncAction(async () => {
    await controlWhisper('start', SILENT);
    toast.success('Whisper started');
    await refresh();
  });
  const [freeAll, freeingAll] = useAsyncAction(async () => {
    // Re-poll first — the optimistic UI's `loadedOllama` snapshot is up to
    // POLL_MS old, and the ollama unload now requires the model to actually
    // be resident (else returns `not loaded`). Read from the returned
    // snapshot rather than component state — React's async setState in
    // refresh() won't have flushed by the time `loadedOllama` etc. is
    // referenced in this same closure.
    const fresh = (await refresh()) || { loadedOllama: [], whisperRunning: false, ttsState: { state: 'lazy' } };
    // Fan out in parallel — the operations don't depend on each other and
    // doing them serially would visibly stall on whisper's PM2-delete step.
    // Per-step errors get swallowed here because freeAll is the "best effort"
    // path; the trailing refresh() then shows what actually got freed.
    // Per-step toasts would also stack four-deep on success which is noise.
    const results = await Promise.allSettled([
      ...fresh.loadedOllama.map((m) => unloadOllamaModel(m.id, SILENT)),
      fresh.whisperRunning ? controlWhisper('stop', SILENT) : Promise.resolve(),
      fresh.ttsState.state !== 'lazy' ? unloadKokoroTts(SILENT) : Promise.resolve(),
    ]);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed) toast.error(`Freed most resources — ${failed} action(s) failed`);
    else toast.success('Freed all memory-resident models');
    await refresh();
  });

  if (loading) {
    return (
      <div className="bg-port-card border border-port-border rounded p-3 mb-4">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <BrailleSpinner /> Loading memory status…
        </div>
      </div>
    );
  }

  const anythingLoaded = loadedOllama.length > 0 || whisperRunning || ttsState.state !== 'lazy';
  const anyActionRunning =
    unloadingModel || unloadingKokoro || stoppingWhisper || startingWhisper || freeingAll;

  return (
    <div className="bg-port-card border border-port-border rounded mb-4">
      <div className="flex items-center justify-between px-3 py-2 border-b border-port-border">
        <div>
          <div className="text-sm font-semibold text-gray-200">Memory Management</div>
          <div className="text-xs text-gray-500">
            Free unified memory before running large diffusion / video models
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={refresh}
            disabled={anyActionRunning}
            className={`${btnClass} text-gray-400 hover:text-gray-200 hover:bg-port-border/40`}
            title={`Last refreshed ${Math.max(0, Math.floor((Date.now() - lastFetched) / 1000))}s ago`}
          >
            <RefreshCw className="w-3 h-3" />
            Refresh
          </button>
          <button
            type="button"
            onClick={freeAll}
            disabled={!anythingLoaded || anyActionRunning}
            className={`${btnClass} text-port-warning border border-port-warning/50 hover:bg-port-warning/10`}
          >
            <Trash2 className="w-3 h-3" />
            Free everything
          </button>
        </div>
      </div>

      {loadedOllama.length === 0 && !whisperRunning && ttsState.state === 'lazy' ? (
        <div className="px-3 py-3 text-xs text-gray-500 italic">
          Nothing memory-resident — full unified memory is available for diffusion.
        </div>
      ) : (
        <div>
          {loadedOllama.map((m) => (
            <Row
              key={`ollama:${m.id}`}
              icon={Cpu}
              title={m.name}
              subtitle="Ollama"
              status={formatBytes(m.sizeVram ?? m.size ?? 0)}
              action={
                <button
                  type="button"
                  onClick={() => unloadModel(m.id)}
                  disabled={anyActionRunning}
                  className={`${btnClass} text-gray-300 border border-port-border hover:bg-port-border/40`}
                >
                  Unload
                </button>
              }
              danger
            />
          ))}
          {whisperRunning && (
            <Row
              icon={Mic}
              title="Whisper STT"
              subtitle="PM2 process portos-whisper — voice transcription"
              status="running"
              action={
                <button
                  type="button"
                  onClick={stopWhisper}
                  disabled={anyActionRunning}
                  className={`${btnClass} text-gray-300 border border-port-border hover:bg-port-border/40`}
                >
                  <PowerOff className="w-3 h-3" />
                  Stop
                </button>
              }
              danger
            />
          )}
          {ttsState.state !== 'lazy' && (
            <Row
              icon={Volume2}
              title="Kokoro TTS"
              subtitle={ttsState.loadedKey || 'kokoro-js ONNX in-process'}
              status={ttsState.state === 'loading' ? 'loading…' : 'loaded'}
              action={
                <button
                  type="button"
                  onClick={unloadKokoro}
                  disabled={anyActionRunning || ttsState.state === 'loading'}
                  className={`${btnClass} text-gray-300 border border-port-border hover:bg-port-border/40`}
                >
                  Unload
                </button>
              }
              danger
            />
          )}
        </div>
      )}

      {!whisperRunning && sttEngine === 'whisper' && (
        <div className="px-3 py-2 border-t border-port-border/50 flex items-center gap-2 text-xs text-gray-500">
          <AlertTriangle className="w-3 h-3 text-port-warning shrink-0" />
          <span className="flex-1">Whisper is stopped — voice transcription is offline.</span>
          <button
            type="button"
            onClick={startWhisper}
            disabled={anyActionRunning}
            className={`${btnClass} text-gray-300 border border-port-border hover:bg-port-border/40`}
          >
            <Power className="w-3 h-3" />
            Start Whisper
          </button>
        </div>
      )}
    </div>
  );
}
