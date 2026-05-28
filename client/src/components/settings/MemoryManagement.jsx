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
// Polls every 5s while mounted. Errors surface via the default apiCore toast
// (no custom catch), so a single layer wins per the project convention.

import { useState, useEffect, useCallback } from 'react';
import { Cpu, Mic, Volume2, Trash2, Power, PowerOff, RefreshCw, AlertTriangle } from 'lucide-react';
import toast from '../ui/Toast';
import BrailleSpinner from '../BrailleSpinner';
import { useAsyncAction } from '../../hooks/useAsyncAction.js';
import { formatBytes } from '../../utils/formatters';
import { getLoadedLlmModels, unloadOllamaModel } from '../../services/apiLocalLlm.js';
import { getTtsStatus, unloadKokoroTts, controlWhisper, getVoiceStatus } from '../../services/apiVoice.js';

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
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState(0);

  const refresh = useCallback(async () => {
    const [llm, tts, voice] = await Promise.all([
      getLoadedLlmModels().catch(() => ({ ollama: [] })),
      getTtsStatus().catch(() => ({ kokoro: { state: 'lazy', loadedKey: null } })),
      getVoiceStatus().catch(() => null),
    ]);
    setLoadedOllama(Array.isArray(llm?.ollama) ? llm.ollama : []);
    setTtsState(tts?.kokoro || { state: 'lazy', loadedKey: null });
    // voice.services.whisper.ok is the "PM2 process responsive" probe in
    // checkAll(). When the service block is missing (status fetch failed) we
    // default to "not running" — false negatives just mean the Stop button
    // briefly hides, which the next poll corrects.
    setWhisperRunning(Boolean(voice?.services?.whisper?.ok));
    setLoading(false);
    setLastFetched(Date.now());
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const [unloadModel, unloadingModel] = useAsyncAction(async (modelId) => {
    await unloadOllamaModel(modelId);
    toast.success(`Unloaded ${modelId}`);
    await refresh();
  });
  const [unloadKokoro, unloadingKokoro] = useAsyncAction(async () => {
    const result = await unloadKokoroTts();
    toast.success(result?.unloaded ? 'Kokoro TTS unloaded' : 'Kokoro was not loaded');
    await refresh();
  });
  const [stopWhisper, stoppingWhisper] = useAsyncAction(async () => {
    await controlWhisper('stop');
    toast.success('Whisper stopped');
    await refresh();
  });
  const [startWhisper, startingWhisper] = useAsyncAction(async () => {
    await controlWhisper('start');
    toast.success('Whisper started');
    await refresh();
  });
  const [freeAll, freeingAll] = useAsyncAction(async () => {
    // Fan out in parallel — the operations don't depend on each other and
    // doing them serially would visibly stall on whisper's PM2-delete step.
    // Per-step errors get swallowed here because freeAll is the "best effort"
    // path; refresh() then shows what actually got freed. Per-step toasts
    // would also stack four-deep on success which is just noise.
    const results = await Promise.allSettled([
      ...loadedOllama.map((m) => unloadOllamaModel(m.id)),
      whisperRunning ? controlWhisper('stop') : Promise.resolve(),
      ttsState.state !== 'lazy' ? unloadKokoroTts() : Promise.resolve(),
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

      {!whisperRunning && (
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
