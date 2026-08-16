// Panel that surfaces what's currently resident in unified memory and lets
// the user evict it. The motivating workflow: "I want to render with FLUX.2
// 9B bf16 (~36 GB) — what's holding memory right now that I can free?"
//
// Sources of residency this panel covers:
//   - Ollama models (multiple can be loaded simultaneously) → /api/local-llm/loaded
//   - LM Studio models → /api/local-llm/loaded
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

import { useState, useEffect, useCallback, useRef } from 'react';
import { Cpu, Mic, Volume2, Trash2, Power, PowerOff, RefreshCw, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import useMounted from '../../hooks/useMounted.js';
import { formatBytes } from '../../utils/formatters';
import {
  getLoadedLlmModels,
  unloadLmStudioModel,
  unloadOllamaModel,
} from '../../services/apiLocalLlm.js';
import { getTtsStatus, unloadKokoroTts, controlWhisper, getVoiceStatus } from '../../services/apiVoice.js';

const SILENT = { silent: true };

const POLL_MS = 5000;

const EMPTY_SNAPSHOT = {
  loadedOllama: [],
  loadedLmStudio: [],
  ttsState: { state: 'lazy', loadedKey: null },
  whisperRunning: false,
  sttEngine: 'whisper',
  unavailableSources: [],
};

const SOURCE_LABELS = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  tts: 'text-to-speech',
  voice: 'voice services',
};

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

export default function MemoryManagement({ onLoadedModelsChange } = {}) {
  const [loadedOllama, setLoadedOllama] = useState([]);
  const [loadedLmStudio, setLoadedLmStudio] = useState([]);
  const [ttsState, setTtsState] = useState({ state: 'lazy', loadedKey: null });
  const [whisperRunning, setWhisperRunning] = useState(false);
  const [sttEngine, setSttEngine] = useState('whisper');
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState(0);
  const [unavailableSources, setUnavailableSources] = useState([]);
  // Guards the polled setState calls — a late /voice/status response that
  // resolves after unmount would otherwise call setState on a dead tree.
  // useMounted resets the ref to true on every mount so React 18 StrictMode's
  // mount→cleanup→remount cycle doesn't leave it permanently false (which
  // would otherwise keep the panel stuck on "Loading memory status…" in dev).
  const mountedRef = useMounted();
  const snapshotRef = useRef(EMPTY_SNAPSHOT);
  const refreshGenerationRef = useRef(0);
  const priorityRefreshRef = useRef(false);

  // Returns the fresh snapshot so callers (notably freeAll) can act on the
  // values without waiting for React's async setState to flush — reading
  // component state immediately after `await refresh()` would still see
  // the prior poll's snapshot.
  const refresh = useCallback(async (options = {}) => {
    const priority = options?.priority === true;
    // "Free everything" needs one authoritative pre-action snapshot. Do not
    // let the 5s interval start a newer poll while that priority refresh is in
    // flight, or the caller would have to act on an older last-known snapshot.
    if (!priority && priorityRefreshRef.current) return snapshotRef.current;
    if (priority) priorityRefreshRef.current = true;
    const generation = ++refreshGenerationRef.current;
    const [llmResult, ttsResult, voiceResult] = await Promise.allSettled([
      getLoadedLlmModels(SILENT),
      getTtsStatus(SILENT),
      getVoiceStatus(SILENT),
    ]);
    // A later-started poll/action refresh owns the UI. Return its current
    // snapshot to stale callers instead of letting an old response resurrect a
    // model that was just unloaded.
    if (generation !== refreshGenerationRef.current) {
      if (priority) priorityRefreshRef.current = false;
      return snapshotRef.current;
    }

    const previous = snapshotRef.current;
    const llm = llmResult.status === 'fulfilled' ? llmResult.value : null;
    const tts = ttsResult.status === 'fulfilled' ? ttsResult.value : null;
    const voice = voiceResult.status === 'fulfilled' ? voiceResult.value : null;
    const llmValid = Array.isArray(llm?.ollama) && Array.isArray(llm?.lmstudio);
    const ttsValid = typeof tts?.kokoro?.state === 'string';
    const voiceValid = voice != null && typeof voice === 'object';
    const llmSourceErrors = llmValid && Array.isArray(llm.sourceErrors) ? llm.sourceErrors : [];
    const failedSources = [
      ...(!llmValid ? ['ollama', 'lmstudio'] : llmSourceErrors),
      ...(!ttsValid ? ['tts'] : []),
      ...(!voiceValid ? ['voice'] : []),
    ];
    const snapshot = {
      loadedOllama: llmValid && !llmSourceErrors.includes('ollama') ? llm.ollama : previous.loadedOllama,
      loadedLmStudio: llmValid && !llmSourceErrors.includes('lmstudio') ? llm.lmstudio : previous.loadedLmStudio,
      ttsState: ttsValid ? tts.kokoro : previous.ttsState,
      // voice.services.whisper.ok is the "PM2 process responsive" probe in
      // checkAll(). When the service block is missing (status fetch failed)
      // we default to "not running" — false negatives just mean the Stop
      // button briefly hides, which the next poll corrects.
      whisperRunning: voiceValid ? Boolean(voice.services?.whisper?.ok) : previous.whisperRunning,
      sttEngine: voiceValid ? (voice.sttEngine || 'whisper') : previous.sttEngine,
      unavailableSources: [...new Set(failedSources)],
    };
    snapshotRef.current = snapshot;
    if (priority) priorityRefreshRef.current = false;
    if (!mountedRef.current) return snapshot;
    setLoadedOllama(snapshot.loadedOllama);
    setLoadedLmStudio(snapshot.loadedLmStudio);
    setTtsState(snapshot.ttsState);
    setWhisperRunning(snapshot.whisperRunning);
    setSttEngine(snapshot.sttEngine);
    setUnavailableSources(snapshot.unavailableSources);
    setLoading(false);
    setLastFetched(Date.now());
    onLoadedModelsChange?.({
      ollama: snapshot.loadedOllama,
      lmstudio: snapshot.loadedLmStudio,
      sourceErrors: snapshot.unavailableSources.filter((source) => source === 'ollama' || source === 'lmstudio'),
    });
    return snapshot;
  }, [mountedRef, onLoadedModelsChange]);

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
  const [unloadLmStudio, unloadingLmStudio] = useAsyncAction(async (modelId) => {
    await unloadLmStudioModel(modelId, SILENT);
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
    const fresh = (await refresh({ priority: true })) || EMPTY_SNAPSHOT;
    const sourceUnknown = (source) => fresh.unavailableSources.includes(source);
    // Fan out in parallel — the operations don't depend on each other and
    // doing them serially would visibly stall on whisper's PM2-delete step.
    // Per-step errors get swallowed here because freeAll is the "best effort"
    // path; the trailing refresh() then shows what actually got freed.
    // Per-step toasts would also stack four-deep on success which is noise.
    const results = await Promise.allSettled([
      ...(!sourceUnknown('ollama') ? fresh.loadedOllama.map((m) => unloadOllamaModel(m.id, SILENT)) : []),
      ...(!sourceUnknown('lmstudio') ? fresh.loadedLmStudio.map((m) => unloadLmStudioModel(m.id, SILENT)) : []),
      !sourceUnknown('voice') && fresh.whisperRunning ? controlWhisper('stop', SILENT) : Promise.resolve(),
      !sourceUnknown('tts') && fresh.ttsState.state !== 'lazy' ? unloadKokoroTts(SILENT) : Promise.resolve(),
    ]);
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (fresh.unavailableSources.length > 0) {
      const labels = fresh.unavailableSources.map((source) => SOURCE_LABELS[source] || source).join(', ');
      toast.error(`Freed verified resources only — could not verify ${labels}`);
    } else if (failed) toast.error(`Freed most resources — ${failed} action(s) failed`);
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

  const anythingLoaded = loadedOllama.length > 0 || loadedLmStudio.length > 0
    || whisperRunning || ttsState.state !== 'lazy';
  const anyActionRunning =
    unloadingModel || unloadingLmStudio || unloadingKokoro || stoppingWhisper || startingWhisper || freeingAll;

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

      {unavailableSources.length > 0 && (
        <div className="mx-3 mt-3 flex items-start gap-2 rounded border border-port-warning/30 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            Status unavailable for {unavailableSources.map((source) => SOURCE_LABELS[source] || source).join(', ')}.
            Last known values remain visible; unknown resources are excluded from Free everything.
          </span>
        </div>
      )}

      {loadedOllama.length === 0 && loadedLmStudio.length === 0
        && !whisperRunning && ttsState.state === 'lazy' && unavailableSources.length === 0 ? (
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
                  aria-label={`Unload ${m.name || m.id}`}
                  className={`${btnClass} text-gray-300 border border-port-border hover:bg-port-border/40`}
                >
                  Unload
                </button>
              }
              danger
            />
          ))}
          {loadedLmStudio.map((m) => (
            <Row
              key={`lmstudio:${m.id}`}
              icon={Cpu}
              title={m.id}
              subtitle="LM Studio"
              status="loaded"
              action={
                <button
                  type="button"
                  onClick={() => unloadLmStudio(m.id)}
                  disabled={anyActionRunning}
                  aria-label={`Unload ${m.id}`}
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

      {!whisperRunning && sttEngine === 'whisper' && !unavailableSources.includes('voice') && (
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
