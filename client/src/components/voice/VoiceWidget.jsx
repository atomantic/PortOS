import { useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Mic, MicOff, Brain, Hourglass, Volume2 } from 'lucide-react';
import VoiceCallConsole from './VoiceCallConsole';
import SatPhoneHandset from './SatPhoneHandset';
import VoiceCompactBar, { DictationBanner, VoiceMobileFab } from './VoiceCompactBar';
import { useVoiceImages } from './useVoiceImages';
import { useVoiceFastPath } from './useVoiceFastPath';
import { useVoiceSocketEvents } from './useVoiceSocketEvents';
import { useAvatarRuntime } from './useAvatarRuntime';
import { activeChannelOf, useAvatarLibrary } from './useAvatarLibrary';
import { useVoiceUiSync } from './useVoiceUiSync';
import { applyChannelPersonality, hasChannelPersona } from '../../../../server/lib/voiceChannels.js';
import { useSidebarContext } from '../SidebarContext';
import {
  startCapture, stopCapture, interrupt, resetConversation, sendText, isCapturing,
  startContinuous, stopContinuous, isContinuous, getVadLevel,
  webSpeechSupported, startWebSpeechCapture, stopWebSpeechCapture, isWebSpeechCapturing,
  disposeCaptureOwner, enableVisionCapture, disableVisionCapture, onVisionCaptureEnded,
  onVoiceOutputPrimary, claimVoiceOutput, prepareVoicePlayback,
  getVoiceVolume, setVoiceVolume, isVoiceMuted, setVoiceMuted, onVoiceAudioPrefs, getVoiceOutputLevel,
} from '../../services/voiceClient';
import toast from '../ui/Toast';
import { REALTIME_ACTIVE_EVENT, isRealtimeCallActive } from '../../services/voiceRealtime';
import {
  VISIBILITY_EVENT,
  VISUAL_MODE_EVENT,
  ENGAGE_EVENT,
  DISENGAGE_EVENT,
  readVoiceHidden,
  writeVoiceHidden,
  isVoiceHiddenStorageEvent,
  readVoiceVisualMode,
  writeVoiceVisualMode,
  isVoiceVisualModeStorageEvent,
} from '../../services/voiceVisibility';
import {
  SFX_EVENT,
  readTransceiverSfx,
  writeTransceiverSfx,
  isTransceiverSfxStorageEvent,
  playRadioCue,
} from '../../lib/voiceTransceiverSfx';
import { isPushToTalkKey } from '../../lib/a11yKeyboard';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

// Peak below this (0..1) is usually whisper's [BLANK_AUDIO] territory.
const QUIET_MIC_THRESHOLD = 0.02;

const HANDS_FREE_KEY = 'portos.voice.handsFree';

const STAGE = {
  idle: { icon: Mic, label: '', tone: 'text-gray-300' },
  listening: { icon: MicOff, label: 'Listening… (click to send)', tone: 'text-port-accent' },
  handsfree: { icon: MicOff, label: 'Hands-free — speak anytime', tone: 'text-port-accent' },
  capturing: { icon: MicOff, label: 'Capturing your voice…', tone: 'text-port-accent animate-pulse' },
  loading: { icon: Hourglass, label: 'Loading model into memory…', tone: 'text-port-warning animate-pulse' },
  thinking: { icon: Brain, label: 'Thinking…', tone: 'text-port-warning' },
  speaking: { icon: Volume2, label: 'Speaking (talk to interrupt)', tone: 'text-port-success' },
};

// Stages where the mic is live and/or the user is mid-utterance — do not
// overwrite these when a server event would otherwise demote them.
const ACTIVE_STAGES = new Set(['listening', 'capturing', 'handsfree']);

const MAX_HISTORY = 50;

const warnIfQuiet = (peak) => {
  if (typeof peak === 'number' && peak < QUIET_MIC_THRESHOLD) {
    toast(`Mic very quiet (peak ${peak.toFixed(3)}). Check input device / volume.`, { icon: '🎤' });
  }
};

// Loaded on demand by `VoiceWidgetGate`, which owns the voice config read and
// its `voice:config:changed` subscription and hands the result down as
// `config`. `claimHeld` returns, once, what happened while this chunk was
// still loading: `{ start, dictation }`.
export default function VoiceWidget({ config, claimHeld, consoleHost }) {
  // Read at capture start so a settings change applies to the next turn without rebinding the mic.
  const vadRef = useRef(config.vad);
  vadRef.current = config.vad;
  const navigate = useNavigate();
  const { enabled, hotkey, sttEngine, sttLanguage, fastPath, personality: globalPersonality, llm, tts } = config;
  // The on-device fast path answers as the on-air channel's persona, as the server does.
  const { data: channelLibrary } = useAvatarLibrary(Boolean(enabled && fastPath?.enabled && fastPath?.browserLlm));
  const onAirAgent = activeChannelOf(channelLibrary)?.agent;
  const personality = useMemo(
    () => (hasChannelPersona(onAirAgent) ? applyChannelPersonality(globalPersonality, onAirAgent) : globalPersonality),
    [globalPersonality, onAirAgent],
  );
  const [llmOverride, setLlmOverride] = useState(null);
  useEffect(() => { setLlmOverride(null); }, [llm?.provider, llm?.model]);
  const activeLlmProvider = llmOverride?.provider || llm?.provider || 'lmstudio';
  const activeLlmModel = llmOverride?.model || llm?.model || 'auto';
  const turnGenerationRef = useRef(0);
  const [stage, setStage] = useState('idle');
  const [history, setHistory] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [dictationActive, setDictationActive] = useState(false);
  // Refs held by the voice:dictation listener and the sidebar engage/disengage
  // listeners so they call the latest closures without re-binding listeners.
  const handleStartRef = useRef(null);
  const handleStopRef = useRef(null);
  const handleCancelRef = useRef(null);
  const disposedRef = useRef(false);
  // Queues an engage that arrived while voice was disabled so it replays once enabled flips true.
  const pendingEngageRef = useRef(false);
  // Tracks the in-flight handleCancel() promise so a rapid disengage/hide→engage
  // awaits teardown before opening a new capture on voiceClient's module-level recorder.
  const cancelInFlightRef = useRef(null);
  // Bumped by engage, disengage, hide, endCall and unmount so an engage waiting
  // on cancelInFlightRef knows it was superseded and must not reopen the mic.
  const engageSeqRef = useRef(0);
  const [handsFree, setHandsFree] = useState(() => {
    const stored = safeReadStorage(HANDS_FREE_KEY);
    return stored === null ? true : stored === '1';
  });
  const [hidden, setHidden] = useState(readVoiceHidden);
  const [visualMode, setVisualMode] = useState(readVoiceVisualMode);
  const [audioPrefs, setAudioPrefs] = useState(() => ({
    volume: typeof getVoiceVolume === 'function' ? getVoiceVolume() : 0.85,
    muted: typeof isVoiceMuted === 'function' ? isVoiceMuted() : false,
  }));
  const [sfxEnabled, setSfxEnabled] = useState(readTransceiverSfx);
  const { collapsed: sidebarCollapsed, desktop: desktopNav } = useSidebarContext();
  const [level, setLevel] = useState(0);
  const [visionEnabled, setVisionEnabled] = useState(false);
  const [isVoiceOutputTab, setIsVoiceOutputTab] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fabRef = useRef(null);
  // Focus target restored after an expand/minimize render commits.
  const pendingFocusRef = useRef(null);
  const conversationId = useId();
  const useWebSpeech = sttEngine === 'web-speech' && webSpeechSupported;

  // `at` lets the Voice Call timing debug interleave its lines with the turns.
  const appendHistory = useCallback((entry) => {
    setHistory((h) => [...h, { at: Date.now(), ...entry }].slice(-MAX_HISTORY));
  }, []);

  const appendAssistantDelta = useCallback((delta) => {
    setHistory((h) => {
      const last = h[h.length - 1];
      if (last?.role === 'assistant') {
        return [...h.slice(0, -1), { ...last, text: last.text + delta }];
      }
      return [...h, { role: 'assistant', text: delta, at: Date.now() }].slice(-MAX_HISTORY);
    });
  }, []);

  const clearHistory = useCallback(() => setHistory([]), []);

  const playCue = useCallback((cue, overrides = {}) => {
    playRadioCue(cue, {
      volume: audioPrefs.volume,
      muted: audioPrefs.muted,
      enabled: sfxEnabled,
      ...overrides,
    });
  }, [audioPrefs.volume, audioPrefs.muted, sfxEnabled]);

  // Images queued for the next turn; a sent image moves onto the user's turn.
  const images = useVoiceImages({
    enabled,
    onSent: (image) => setHistory((h) => {
      const at = h.findLastIndex((turn) => turn.role === 'user');
      if (at === -1) return h;
      const turn = h[at];
      return [...h.slice(0, at), { ...turn, images: [...(turn.images || []), image] }, ...h.slice(at + 1)];
    }),
  });

  // Keep the server's UI index fresh so the LLM can drive the current page.
  useVoiceUiSync(enabled);

  const { runFastPath, fastPathRef } = useVoiceFastPath({
    enabled,
    fastPath,
    personality,
    tts,
    dictationActive,
    history,
    pendingImagesRef: images.pendingRef,
    disposedRef,
    turnGenerationRef,
    activeStages: ACTIVE_STAGES,
    navigate,
    appendHistory,
    setStage,
  });

  useVoiceSocketEvents({
    enabled,
    navigate,
    disposedRef,
    turnGenerationRef,
    handleStartRef,
    handleStopRef,
    activeStages: ACTIVE_STAGES,
    appendHistory,
    appendAssistantDelta,
    clearHistory,
    setStage,
    setDictationActive,
    setVisionEnabled,
  });

  // Stop every active capture engine unconditionally (independent of current
  // `useWebSpeech` so a mid-capture engine switch cannot strand a live mic)
  // and drop queued TTS once mic teardown settles.
  const handleCancel = useCallback(async ({ updateUi = true } = {}) => {
    turnGenerationRef.current += 1;
    if (isWebSpeechCapturing()) stopWebSpeechCapture();
    if (updateUi && !disposedRef.current) setInterimTranscript('');
    const stops = [];
    if (isContinuous()) stops.push(stopContinuous().catch(() => {}));
    if (isCapturing()) stops.push(stopCapture({ submit: false }).catch(() => {}));
    if (stops.length) await Promise.all(stops);
    interrupt();
    if (updateUi && !disposedRef.current) setStage('idle');
  }, []);

  // Serialize teardown through `cancelInFlightRef` so any engage that lands
  // while a previous stop/hide/disengage/unmount is releasing tracks waits.
  // Overlapping cancellations combine with any still-pending teardown so a
  // faster second cancel can never clear `cancelInFlightRef` before an earlier
  // mic release settles.
  const trackCancel = useCallback((options) => {
    const previous = cancelInFlightRef.current;
    const teardown = handleCancelRef.current?.(options);
    if (!teardown || typeof teardown.then !== 'function') return previous || teardown;
    const combined = previous ? Promise.allSettled([previous, teardown]).then(() => undefined) : teardown;
    cancelInFlightRef.current = combined;
    combined.finally(() => {
      if (cancelInFlightRef.current === combined) cancelInFlightRef.current = null;
    });
    return combined;
  }, []);

  // Disabling voice mode must release every mic path and drop queued TTS.
  useEffect(() => {
    if (enabled) return;
    trackCancel();
  }, [enabled, trackCancel]);

  // Keep the vision toggle in sync with the actual capture stream and release on unmount.
  useEffect(() => {
    const off = onVisionCaptureEnded(() => setVisionEnabled(false));
    return () => { off(); disableVisionCapture(); };
  }, []);

  useEffect(() => onVoiceOutputPrimary(setIsVoiceOutputTab), []);

  useEffect(() => {
    if (typeof onVoiceAudioPrefs !== 'function') return undefined;
    return onVoiceAudioPrefs(setAudioPrefs);
  }, []);

  // Sync visibility, visual mode (handset vs compact bar), and transceiver SFX across tabs.
  useEffect(() => {
    const syncHidden = () => setHidden(readVoiceHidden());
    const syncVisual = () => setVisualMode(readVoiceVisualMode());
    const syncSfx = () => setSfxEnabled(readTransceiverSfx());
    const onStorage = (e) => {
      if (isVoiceHiddenStorageEvent(e)) syncHidden();
      if (isVoiceVisualModeStorageEvent(e)) syncVisual();
      if (isTransceiverSfxStorageEvent(e)) syncSfx();
    };
    window.addEventListener(VISIBILITY_EVENT, syncHidden);
    window.addEventListener(VISUAL_MODE_EVENT, syncVisual);
    window.addEventListener(SFX_EVENT, syncSfx);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(VISIBILITY_EVENT, syncHidden);
      window.removeEventListener(VISUAL_MODE_EVENT, syncVisual);
      window.removeEventListener(SFX_EVENT, syncSfx);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const floatingFullVisible = enabled && !hidden && !consoleHost && visualMode === 'full';
  const { data: floatingAvatarData, error: floatingAvatarError } = useAvatarRuntime(floatingFullVisible, { autoStart: true });
  const runningFloatingAvatar = Boolean(!floatingAvatarError && floatingAvatarData?.supported && floatingAvatarData.phase === 'running');

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, interimTranscript]);

  const handleStart = useCallback(async () => {
    if (!enabled || disposedRef.current) return;
    // A realtime call has the mic and the conversation; listening here would answer the same words a second time.
    if (isRealtimeCallActive()) {
      toast('Hang up the realtime call to use the regular voice.');
      return;
    }

    if (useWebSpeech) {
      if (isWebSpeechCapturing()) return;
      setStage('listening');
      setInterimTranscript('');
      startWebSpeechCapture({
        language: sttLanguage,
        onInterim: (text) => {
          if (!disposedRef.current) setInterimTranscript(text);
        },
        onFinal: (text) => {
          if (disposedRef.current) return;
          setInterimTranscript('');
          appendHistory({ role: 'user', text });
          setStage('thinking');
        },
        routeFinal: async (text) => {
          if (disposedRef.current) return;
          const generation = ++turnGenerationRef.current;
          const handled = fastPathRef.current?.enabled ? await runFastPath(text) : false;
          if (!disposedRef.current && generation === turnGenerationRef.current && !handled) sendText(text, 'voice');
        },
        onError: (err) => {
          if (disposedRef.current) return;
          toast.error(`Mic: ${err}`);
          setStage('idle');
        },
      });
      return;
    }

    if (handsFree) {
      if (isContinuous()) return;
      setStage('handsfree');
      await startContinuous({
        vad: vadRef.current,
        onSpeechStart: () => {
          if (!disposedRef.current) setStage('capturing');
        },
        onSpeechEnd: () => {
          if (!disposedRef.current) setStage('thinking');
        },
        onSubmit: ({ submitted, peak }) => {
          if (disposedRef.current) return;
          if (!submitted) {
            setStage('handsfree');
            return;
          }
          warnIfQuiet(peak);
        },
      }).catch((err) => {
        if (disposedRef.current) return;
        toast.error(`Mic: ${err.message}`);
        setStage('idle');
      });
      return;
    }
    if (isCapturing()) return;
    setStage('listening');
    await startCapture().catch((err) => {
      if (disposedRef.current) return;
      toast.error(`Mic: ${err.message}`);
      setStage('idle');
    });
  }, [enabled, handsFree, useWebSpeech, sttLanguage, appendHistory, runFastPath, fastPathRef]);

  const handleStop = useCallback(async () => {
    if (disposedRef.current) return;
    if (useWebSpeech) {
      stopWebSpeechCapture();
      setInterimTranscript('');
      setStage('idle');
      return;
    }
    if (handsFree && isContinuous()) {
      await stopContinuous();
      if (disposedRef.current) return;
      setStage('idle');
      return;
    }
    if (!isCapturing()) return;
    setStage('thinking');
    const r = await stopCapture().catch((err) => {
      if (disposedRef.current) return null;
      toast.error(`Mic: ${err.message}`);
      setStage('idle');
      return null;
    });
    if (disposedRef.current) return;
    if (!r) {
      setStage('idle');
      return;
    }
    warnIfQuiet(r.peak);
  }, [handsFree, useWebSpeech]);

  // Synchronously refresh handler refs after commit so same-tick window/socket
  // events never observe a stale closure where `enabled` was still false.
  useLayoutEffect(() => { handleStartRef.current = handleStart; }, [handleStart]);
  useLayoutEffect(() => { handleStopRef.current = handleStop; }, [handleStop]);
  useLayoutEffect(() => { handleCancelRef.current = handleCancel; }, [handleCancel]);

  // Invalidate module-level capture callbacks synchronously on unmount, then
  // run the awaited cancel teardown without updating React state.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      engageSeqRef.current += 1;
      pendingEngageRef.current = false;
      disposeCaptureOwner();
      trackCancel({ updateUi: false });
    };
  }, [trackCancel]);

  const handleClear = useCallback(() => {
    turnGenerationRef.current += 1;
    resetConversation();
    clearHistory();
  }, [clearHistory]);

  const handleInterrupt = useCallback(() => {
    turnGenerationRef.current += 1;
    interrupt();
    setStage((current) => (
      ACTIVE_STAGES.has(current)
        ? current
        : (isWebSpeechCapturing() ? 'listening' : isContinuous() ? 'handsfree' : 'idle')
    ));
  }, []);

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    appendHistory({ role: 'user', text });
    setDraft('');
    setStage('thinking');
    const generation = ++turnGenerationRef.current;
    const handled = fastPathRef.current?.enabled ? await runFastPath(text) : false;
    if (disposedRef.current || generation !== turnGenerationRef.current || handled) return;
    sendText(text);
  }, [draft, appendHistory, runFastPath, fastPathRef]);

  const toggleCapture = useCallback(() => {
    if (cancelInFlightRef.current) return;
    const active = isWebSpeechCapturing() || isCapturing() || isContinuous();
    playCue(active ? 'tx-end' : 'tx-start');
    if (active) handleStop();
    else handleStart();
  }, [handleStart, handleStop, playCue]);

  const toggleHandsFree = useCallback(() => {
    playCue('click');
    const next = !handsFree;
    safeWriteStorage(HANDS_FREE_KEY, next ? '1' : '0');
    setHandsFree(next);
    // Discard any in-flight PTT/continuous recording — toggling modes
    // mid-utterance shouldn't ship a partial turn to the server.
    trackCancel();
  }, [handsFree, playCue, trackCancel]);

  const handleVolumeChange = useCallback((nextVolume) => {
    setVoiceVolume?.(nextVolume);
  }, []);

  const handleToggleMute = useCallback((explicit) => {
    const next = typeof explicit === 'boolean' ? explicit : !audioPrefs.muted;
    setVoiceMuted?.(next);
    if (!next) playCue('click', { muted: false });
  }, [audioPrefs.muted, playCue]);

  const handleToggleSfx = useCallback(() => {
    const next = !sfxEnabled;
    writeTransceiverSfx(next);
    setSfxEnabled(next);
    if (next) playCue('click', { enabled: true });
  }, [sfxEnabled, playCue]);

  const handleSetVisualMode = useCallback((nextMode) => {
    playCue('click');
    writeVoiceVisualMode(nextMode);
    setVisualMode(nextMode);
  }, [playCue]);

  const toggleVision = useCallback(async () => {
    if (visionEnabled) {
      disableVisionCapture();
      setVisionEnabled(false);
      return;
    }
    // getDisplayMedia must run inside this click (user gesture).
    const ok = await enableVisionCapture();
    if (disposedRef.current) {
      if (ok) disableVisionCapture();
      return;
    }
    setVisionEnabled(ok);
    if (!ok) toast('Voice: screen sharing was declined or is unavailable.', { icon: '🖥️' });
  }, [visionEnabled]);

  // Poll the VAD RMS level while hands-free is live, or Web Audio output level
  // while speaking. Idle at rest; deadbanded at 0.002.
  const pollLevel = (handsFree && stage !== 'idle') || stage === 'speaking';
  useEffect(() => {
    if (!pollLevel) {
      setLevel(0);
      return undefined;
    }
    // biome-ignore lint/plugin/lint-no-view-interval: Samples the in-memory VAD/analyser RMS level every 100ms; no I/O.
    const id = setInterval(() => {
      const v = stage === 'speaking'
        ? (typeof getVoiceOutputLevel === 'function' ? getVoiceOutputLevel() : 0)
        : getVadLevel();
      setLevel((prev) => (Math.abs(prev - v) > 0.002 ? v : prev));
    }, 100);
    return () => clearInterval(id);
  }, [pollLevel, stage]);

  // Global push-to-talk hotkey; also un-hides the widget so mic state is visible.
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (!isPushToTalkKey(e, hotkey)) return;
      e.preventDefault();
      if (hidden) writeVoiceHidden(false);
      toggleCapture();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, hotkey, hidden, toggleCapture]);

  // Sidebar engage/disengage listeners plus one-shot claim of starts/dictation
  // queued while this chunk was loading (deferred one microtask for StrictMode).
  useEffect(() => {
    let live = true;
    const onEngage = async () => {
      const seq = ++engageSeqRef.current;
      if (cancelInFlightRef.current) await cancelInFlightRef.current;
      if (!live || disposedRef.current || seq !== engageSeqRef.current) return;
      if (!enabled) {
        pendingEngageRef.current = true;
        return;
      }
      handleStartRef.current?.();
    };
    const onDisengage = () => {
      engageSeqRef.current += 1;
      pendingEngageRef.current = false;
      trackCancel();
    };
    window.addEventListener(ENGAGE_EVENT, onEngage);
    window.addEventListener(DISENGAGE_EVENT, onDisengage);
    queueMicrotask(() => {
      if (!live) return;
      const held = claimHeld?.();
      if (held?.dictation) setDictationActive(true);
      if (held?.start) onEngage();
    });
    return () => {
      live = false;
      window.removeEventListener(ENGAGE_EVENT, onEngage);
      window.removeEventListener(DISENGAGE_EVENT, onDisengage);
    };
  }, [enabled, claimHeld, trackCancel]);

  // Drain a queued engage once voice turns on, serialized behind any cancel.
  useEffect(() => {
    if (!enabled || !pendingEngageRef.current) return undefined;
    pendingEngageRef.current = false;
    const seq = ++engageSeqRef.current;
    (async () => {
      if (cancelInFlightRef.current) await cancelInFlightRef.current;
      if (disposedRef.current || seq !== engageSeqRef.current) return;
      handleStartRef.current?.();
    })();
    return undefined;
  }, [enabled]);

  // Route hide through tracked cancel so a rapid hide→re-engage waits for mic
  // teardown instead of tearing down tracks from the freshly opened capture.
  // If a newer engage supersedes the hide before teardown settles, keep the
  // controls visible instead of leaving the mic live behind a hidden widget.
  const hideWidget = useCallback(async () => {
    const seq = ++engageSeqRef.current;
    pendingEngageRef.current = false;
    await trackCancel();
    if (disposedRef.current || seq !== engageSeqRef.current) return;
    writeVoiceHidden(true);
    // Hand focus to the sidebar toggle before this widget unmounts.
    const target = document.querySelector('[data-voice-toggle]') || document.getElementById('main-content');
    target?.focus();
    setHidden(true);
    toast('Voice widget hidden. Re-enable from the sidebar mic or Settings → Voice.');
  }, [trackCancel]);

  useLayoutEffect(() => {
    const next = pendingFocusRef.current;
    if (!next) return;
    pendingFocusRef.current = null;
    (next === 'input' ? inputRef : fabRef).current?.focus();
  }, [expanded]);

  const sendFromConsole = () => {
    if (!draft.trim()) return;
    prepareVoicePlayback();
    handleSend();
  };

  const toggleConsoleMic = () => {
    prepareVoicePlayback();
    toggleCapture();
  };

  const endCall = useCallback(() => {
    turnGenerationRef.current += 1;
    engageSeqRef.current += 1;
    pendingEngageRef.current = false;
    // Stop even a pending permission request or an unsent push-to-talk turn.
    disposeCaptureOwner();
    disableVisionCapture();
    interrupt();
    setInterimTranscript('');
    setStage('idle');
  }, []);

  // A realtime call takes over the microphone and the conversation: stop this
  // widget's listening and speech when one starts, so the regular pipeline does
  // not hear the same words and answer them in its own voice.
  useEffect(() => {
    const onRealtime = (event) => { if (event.detail?.active) endCall(); };
    window.addEventListener(REALTIME_ACTIVE_EVENT, onRealtime);
    return () => window.removeEventListener(REALTIME_ACTIVE_EVENT, onRealtime);
  }, [endCall]);

  // Leaving the dedicated call console stops its microphone and cancels
  // playback; switching surfaces never mounts a second capture engine.
  const previousConsole = useRef(null);
  useEffect(() => {
    if (previousConsole.current && !consoleHost) endCall();
    previousConsole.current = consoleHost;
  }, [consoleHost, endCall]);

  if (!enabled) return null;

  const capturing = ACTIVE_STAGES.has(stage) || isWebSpeechCapturing();
  const sharedSurfaceProps = {
    stage,
    history,
    scrollRef,
    interimTranscript,
    capturing,
    handsFree,
    canChangeMicMode: !useWebSpeech,
    hotkey,
    draft,
    onDraft: setDraft,
    onSend: sendFromConsole,
    onMic: toggleConsoleMic,
    onMode: toggleHandsFree,
    onInterrupt: handleInterrupt,
    onEnd: endCall,
    onClear: handleClear,
    agentName: globalPersonality?.name || '',
    voiceLabel: tts?.voice || tts?.engine,
    llmProvider: activeLlmProvider,
    llmModel: activeLlmModel,
    onLlmSaved: setLlmOverride,
    volume: audioPrefs.volume,
    muted: audioPrefs.muted,
    onVolumeChange: handleVolumeChange,
    onToggleMute: handleToggleMute,
    sfxEnabled,
    onToggleSfx: handleToggleSfx,
    signalLevel: level,
    visionEnabled,
    onToggleVision: toggleVision,
    images,
  };

  if (consoleHost) {
    return createPortal(
      <VoiceCallConsole
        {...sharedSurfaceProps}
        handsFree={!useWebSpeech && handsFree}
        agentDefaults={{ personality: globalPersonality }}
      />,
      consoleHost,
    );
  }
  if (hidden) return null;

  const { icon: Icon, label, tone } = STAGE[stage] || STAGE.idle;
  const claimSpeaker = () => { if (!isVoiceOutputTab) claimVoiceOutput(); };
  const toggleCollapsed = () => setCollapsed((c) => !c);
  const expandMobile = () => { pendingFocusRef.current = 'input'; setExpanded(true); };
  const minimizeMobile = () => { pendingFocusRef.current = 'fab'; setExpanded(false); };
  // Anchor in the bottom-left corner of the workspace, clearing the fixed desktop sidebar.
  const leftOffsetClass = desktopNav
    ? (sidebarCollapsed ? 'left-20' : 'left-[17rem]')
    : 'left-4';

  return (
    // data-voice-widget marker is used by client/src/services/domIndex.js
    // TEXT_EXCLUDE_SELECTORS to keep the widget's own conversation transcript
    // out of the ui_read visible-text snapshot.
    <aside
      data-voice-widget
      aria-label="Voice assistant"
      className={`fixed bottom-4 z-50 flex flex-col items-start gap-2 transition-[left] duration-300 ${leftOffsetClass}`}
    >
      {!expanded && (
        <VoiceMobileFab
          fabRef={fabRef}
          icon={Icon}
          label={label}
          tone={tone}
          capturing={capturing}
          onExpand={expandMobile}
          onHide={hideWidget}
        />
      )}

      {visualMode === 'full' ? (
        <div className={`${expanded ? 'flex' : 'hidden'} md:flex flex-col items-start gap-2`}>
          {dictationActive && <DictationBanner />}
          <SatPhoneHandset
            {...sharedSurfaceProps}
            variant="floating"
            avatarData={floatingAvatarData}
            runningAvatar={runningFloatingAvatar}
            isVoiceOutputTab={isVoiceOutputTab}
            onClaimVoiceOutput={claimSpeaker}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            conversationId={conversationId}
            inputRef={inputRef}
            onCompactMode={() => handleSetVisualMode('compact')}
            onHideWidget={hideWidget}
            onMinimizeMobile={minimizeMobile}
          />
        </div>
      ) : (
        <VoiceCompactBar
          expanded={expanded}
          collapsed={collapsed}
          conversationId={conversationId}
          history={history}
          interimTranscript={interimTranscript}
          scrollRef={scrollRef}
          inputRef={inputRef}
          draft={draft}
          onDraft={setDraft}
          onSend={handleSend}
          onClear={handleClear}
          onToggleCollapsed={toggleCollapsed}
          images={images}
          dictationActive={dictationActive}
          stage={stage}
          icon={Icon}
          label={label}
          tone={tone}
          capturing={capturing}
          continuousLive={isContinuous()}
          level={level}
          hotkey={hotkey}
          useWebSpeech={useWebSpeech}
          handsFree={handsFree}
          visionEnabled={visionEnabled}
          isVoiceOutputTab={isVoiceOutputTab}
          onFullMode={() => handleSetVisualMode('full')}
          onInterrupt={handleInterrupt}
          onToggleCapture={toggleCapture}
          onMinimizeMobile={minimizeMobile}
          onHideWidget={hideWidget}
          onToggleHandsFree={toggleHandsFree}
          onToggleVision={toggleVision}
          onClaimVoiceOutput={claimSpeaker}
        />
      )}
    </aside>
  );
}
