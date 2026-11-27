import { useState, useEffect, useLayoutEffect, useRef, useCallback, useId } from 'react';
import { createPortal } from 'react-dom';
import { Link, useNavigate } from 'react-router';
import VoiceCallConsole from './VoiceCallConsole';
import SatPhoneHandset from './SatPhoneHandset';
import { useAvatarMode } from './useAvatarMode';
import { useAvatarRuntime } from './useAvatarRuntime';
import { useSidebarContext } from '../SidebarContext';
import { Mic, MicOff, Brain, Volume2, VolumeX, Square, Trash2, ChevronDown, ChevronUp, Send, Infinity as InfinityIcon, NotebookPen, X, EyeOff, Monitor, MonitorOff, Radio, Maximize2 } from 'lucide-react';
import {
  startCapture, stopCapture, interrupt, resetConversation, sendText, onVoiceEvent, isCapturing,
  startContinuous, stopContinuous, isContinuous, whenPlaybackDrained, whenVoiceTurnAudioDrained, getVadLevel,
  webSpeechSupported, startWebSpeechCapture, stopWebSpeechCapture, isWebSpeechCapturing,
  disposeCaptureOwner,
  onProactiveSpeech, captureScreenForVision, sendScreenshotResult,
  enableVisionCapture, disableVisionCapture, isVisionCaptureEnabled, onVisionCaptureEnded,
  speakSynthesized, onVoiceOutputPrimary, claimVoiceOutput, prepareVoicePlayback,
  getVoiceVolume, setVoiceVolume, isVoiceMuted, setVoiceMuted, onVoiceAudioPrefs, getVoiceOutputLevel,
} from '../../services/voiceClient';
import { resolveTurn, buildRouterSystemPrompt, TIER } from '../../services/voiceFastPath';
import { warmNano } from '../../services/browserLlm';
import { getPaletteManifest } from '../../services/apiPalette';
import toast from '../ui/Toast';
import { useVoiceUiSync, pushUiIndexAfterAction } from './useVoiceUiSync';
import { doClick, doFill, doSelect, doSetCheckbox } from '../../services/uiInteract';
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
import { MicroGlyph } from '../micrographics';
import { isPushToTalkKey } from '../../lib/a11yKeyboard';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

// Peak below this (0..1) is usually whisper's [BLANK_AUDIO] territory.
const QUIET_MIC_THRESHOLD = 0.02;

const HANDS_FREE_KEY = 'portos.voice.handsFree';
const DISPLAY_KEY = 'portos.voice.callDisplay';

const STAGE = {
  idle: { icon: Mic, label: '', tone: 'text-gray-300' },
  listening: { icon: MicOff, label: 'Listening… (click to send)', tone: 'text-port-accent' },
  handsfree: { icon: MicOff, label: 'Hands-free — speak anytime', tone: 'text-port-accent' },
  capturing: { icon: MicOff, label: 'Capturing your voice…', tone: 'text-port-accent animate-pulse' },
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
  const { enabled, hotkey, sttEngine, sttLanguage, fastPath, personality, tts } = config;
  const turnGenerationRef = useRef(0);
  const [stage, setStage] = useState('idle');
  const [history, setHistory] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [dictationActive, setDictationActive] = useState(false);
  // Refs held by the voice:dictation listener and the sidebar engage/disengage
  // listeners so they can call the latest handleStart/handleStop/handleCancel
  // closures without re-binding socket listeners on every prop change.
  // Populated in the layout effect that defines the handlers.
  const handleStartRef = useRef(null);
  const handleStopRef = useRef(null);
  const handleCancelRef = useRef(null);
  const disposedRef = useRef(false);
  // handleStart short-circuits while voice is disabled, so an engage that
  // lands then (a start claimed from the gate, or one racing a disable/enable
  // flip) is queued here and replayed when `enabled` becomes true.
  const pendingEngageRef = useRef(false);
  // Tracks the in-flight handleCancel() promise so a rapid disengage→engage
  // can await teardown before starting a new capture. voiceClient holds
  // module-level stream/recorder, so without this serialization the in-flight
  // stop can tear down tracks from the freshly-started capture.
  const cancelInFlightRef = useRef(null);
  // Bumped by engage, disengage and unmount so an onEngage suspended on
  // cancelInFlightRef can tell it was superseded and must not reopen the mic.
  const engageSeqRef = useRef(0);
  const [handsFree, setHandsFree] = useState(() => {
    const stored = safeReadStorage(HANDS_FREE_KEY);
    return stored === null ? true : stored === '1';
  });
  const [hidden, setHidden] = useState(readVoiceHidden);
  const [visualMode, setVisualMode] = useState(readVoiceVisualMode);
  const [floatingAvatar, setFloatingAvatar] = useState(() => safeReadStorage(DISPLAY_KEY) !== 'audio');
  const [audioPrefs, setAudioPrefs] = useState(() => ({
    volume: typeof getVoiceVolume === 'function' ? getVoiceVolume() : 0.85,
    muted: typeof isVoiceMuted === 'function' ? isVoiceMuted() : false,
  }));
  const [sfxEnabled, setSfxEnabled] = useState(readTransceiverSfx);
  const { collapsed: sidebarCollapsed, desktop: desktopNav } = useSidebarContext();
  const [level, setLevel] = useState(0);
  // Whether the user has authorized a screen-capture stream for
  // ui_describe_visually ("what's on this chart?"). Must be enabled from a click
  // (user gesture) — getDisplayMedia can't run from the server-initiated turn.
  const [visionEnabled, setVisionEnabled] = useState(false);
  // Whether THIS tab is the current recipient of proactive voice output. The
  // server routes server-initiated speech (reminders/briefings) to a single
  // tab; this reflects (and lets the user claim) that role so the same line
  // doesn't play on every open tab/machine at once.
  const [isVoiceOutputTab, setIsVoiceOutputTab] = useState(false);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fabRef = useRef(null);
  // Which control should receive focus once the next expand/minimize render
  // commits; the control that held focus unmounts or hides on that transition.
  const pendingFocusRef = useRef(null);
  const conversationId = useId();
  const useWebSpeech = sttEngine === 'web-speech' && webSpeechSupported;

  // Fast-resolution cascade config (trigger → on-device Nano → server). Mirrored
  // into refs so the routeFinal closure handed to startWebSpeechCapture always
  // reads the latest values without re-binding the recognizer on every config
  // change.
  const fastPathRef = useRef(fastPath);
  const personalityRef = useRef(personality);
  const ttsRef = useRef(tts);
  const navEntriesRef = useRef([]);
  const dictationActiveRef = useRef(false);
  const lastAssistantReplyRef = useRef('');

  // Keep the server's UI index fresh so the LLM knows what's on the page
  // and can drive it with ui_click / ui_fill / ui_select / ui_check.
  useVoiceUiSync(enabled);

  // Disabling voice mode (via Settings or the socket broadcast) must release
  // every mic path — MediaRecorder, AudioWorklet VAD, and Web Speech — plus
  // drop any queued TTS. Without this, a user who turns voice off while
  // hands-free is listening leaves the mic active in the background.
  useEffect(() => {
    if (enabled) return;
    if (isWebSpeechCapturing()) stopWebSpeechCapture();
    if (isContinuous()) stopContinuous();
    if (isCapturing()) stopCapture({ submit: false });
    interrupt();
    setStage('idle');
  }, [enabled]);

  // Keep the cascade refs pointed at the latest config so the routeFinal closure
  // (bound once at capture start) always triages against current settings.
  useLayoutEffect(() => {
    fastPathRef.current = fastPath;
    personalityRef.current = personality;
    ttsRef.current = tts;
  }, [fastPath, personality, tts]);
  useLayoutEffect(() => { dictationActiveRef.current = dictationActive; }, [dictationActive]);

  // Load the palette nav manifest so tier-1 trigger navigation ("go to tasks")
  // can resolve against the same routes ⌘K uses. Memoized + self-healing: a
  // failed fetch clears the in-flight promise so the next turn retries, instead
  // of permanently disabling tier-1 nav for the session.
  const navFetchRef = useRef(null);
  const ensureNavEntries = useCallback(async () => {
    if (navEntriesRef.current.length) return;
    if (!navFetchRef.current) {
      navFetchRef.current = getPaletteManifest({ silent: true })
        .then((data) => { navEntriesRef.current = Array.isArray(data?.nav) ? data.nav : []; })
        .catch(() => { navFetchRef.current = null; }); // allow retry on the next turn
    }
    await navFetchRef.current;
  }, []);

  // Prefetch the manifest when the trigger tier is active so the first "go to X"
  // doesn't pay the fetch (falls back to the lazy retry in runFastPath on failure).
  useEffect(() => {
    if (!enabled || !fastPath?.enabled || !fastPath?.triggers) return;
    ensureNavEntries();
  }, [enabled, fastPath?.enabled, fastPath?.triggers, ensureNavEntries]);

  // Pre-warm the on-device model when the browser-LLM tier is active so the
  // first spoken turn doesn't pay session-creation latency. Use the SAME router
  // system prompt real turns use, so the warmed session isn't torn down and
  // rebuilt on the first turn (the session cache is keyed by the prompt). No-op
  // unless Nano is already downloaded (we never kick off a download here).
  useEffect(() => {
    if (!enabled || !fastPath?.enabled || !fastPath?.browserLlm) return;
    warmNano({
      systemPrompt: buildRouterSystemPrompt(personalityRef.current || {}),
      temperature: fastPath?.browser?.temperature ?? 0.7,
      topK: fastPath?.browser?.topK ?? 3,
    }).catch(() => {});
    // personalityRef is read inside, so the fields that shape the router prompt
    // are listed explicitly to re-warm Nano when they change.
  }, [enabled, fastPath?.enabled, fastPath?.browserLlm, personality?.name, personality?.speechStyle, fastPath?.browser?.temperature, fastPath?.browser?.topK]);

  useEffect(() => {
    if (!enabled) return;
    const appendUser = (text) => setHistory((h) => [...h, { role: 'user', text }].slice(-MAX_HISTORY));
    const appendAssistantDelta = (delta) => setHistory((h) => {
      const last = h[h.length - 1];
      if (last?.role === 'assistant') {
        return [...h.slice(0, -1), { role: 'assistant', text: last.text + delta }];
      }
      return [...h, { role: 'assistant', text: delta }].slice(-MAX_HISTORY);
    });

    const restState = () => {
      if (isWebSpeechCapturing()) return 'listening';
      if (isContinuous()) return 'handsfree';
      return 'idle';
    };

    const offs = [
      onVoiceEvent('voice:transcript', (d) => {
        // In web-speech mode, user text is already appended client-side
        // when onFinal fires. Server echoes it back with source='text' —
        // skip the duplicate append but still advance the stage.
        if (d.text && d.source !== 'text') appendUser(d.text);
        setStage('thinking');
      }),
      onVoiceEvent('voice:llm:delta', (d) => {
        if (d.delta) appendAssistantDelta(d.delta);
      }),
      onVoiceEvent('voice:tts:audio', () => {
        // 'handsfree' is intentionally NOT preserved here — the arrival of
        // TTS audio means the bot is speaking, so stage must advance.
        setStage((current) => (
          current === 'listening' || current === 'capturing' ? current : 'speaking'
        ));
      }),
      onVoiceEvent('voice:idle', (d) => {
        if (disposedRef.current) return;
        // voice:idle fires when the server finishes *sending* TTS; local
        // playback may still be running. Wait for drain so stage doesn't
        // flip off 'speaking' while audio is still playing.
        if (d?.reason === 'reset') setHistory([]);
        whenVoiceTurnAudioDrained().then(() => {
          if (disposedRef.current) return;
          setStage((current) => (ACTIVE_STAGES.has(current) ? current : restState()));
        });
      }),
      onVoiceEvent('voice:error', (d) => {
        if (disposedRef.current) return;
        toast.error(`Voice: ${d.message}`);
        setStage(restState());
      }),
      onVoiceEvent('voice:navigate', (d) => {
        if (d?.path && typeof d.path === 'string') navigate(d.path);
      }),
      onVoiceEvent('voice:dictation', (d) => {
        const next = !!d?.enabled;
        setDictationActive((prev) => (prev === next ? prev : next));
        // Auto-start the mic when dictation begins — without this, clicking
        // "Dictate" on the Daily Log enabled server-side dictation but the
        // user's mic stayed off, so nothing was ever transcribed. Mirror the
        // stop on the way out so leaving dictation cleans up the recorder.
        // Read handleStart/handleStop through refs so we always pick up the
        // latest closure (engine settings can change at runtime).
        if (next) {
          // Defer to next tick so the local stage / dictation state has
          // settled before handleStart reads it.
          setTimeout(() => {
            if (!disposedRef.current) handleStartRef.current?.();
          }, 0);
        } else if (isWebSpeechCapturing() || isCapturing() || isContinuous()) {
          handleStopRef.current?.();
        }
      }),
      onVoiceEvent('voice:dailyLog:appended', (d) => {
        if (d?.text) {
          const preview = d.text.length > 60 ? `${d.text.slice(0, 60)}…` : d.text;
          toast(`📓 +"${preview}"`);
        }
      }),
      onVoiceEvent('voice:ui:click', (d) => {
        const res = doClick(d?.target);
        if (!res.ok) toast.error(`Voice: couldn't click "${d?.target?.label || d?.target?.ref}"`);
        else pushUiIndexAfterAction();
      }),
      onVoiceEvent('voice:ui:fill', (d) => {
        const res = doFill(d?.target, d?.value);
        if (!res.ok) toast.error(`Voice: couldn't fill "${d?.target?.label || d?.target?.ref}"`);
        else pushUiIndexAfterAction();
      }),
      onVoiceEvent('voice:ui:select', (d) => {
        const res = doSelect(d?.target, d?.option);
        if (!res.ok) toast.error(`Voice: couldn't select "${d?.option}" on "${d?.target?.label}"`);
        else pushUiIndexAfterAction();
      }),
      onVoiceEvent('voice:ui:check', (d) => {
        const res = doSetCheckbox(d?.target, d?.checked);
        if (!res.ok) toast.error(`Voice: couldn't toggle "${d?.target?.label}"`);
        else pushUiIndexAfterAction();
      }),
      // ui_describe_visually: server asks the client to grab a frame of the
      // authorized screen-capture stream. The stream must have been authorized
      // earlier via the monitor button (a user gesture) — getDisplayMedia can't
      // run from this server-initiated event. captureScreenForVision returns a
      // data URL, or null when no stream is authorized / a frame grab failed;
      // always reply so the server-side waiter resolves rather than timing out.
      onVoiceEvent('voice:screenshot:request', async (payload) => {
        if (disposedRef.current) return;
        const requestId = payload && typeof payload === 'object' ? payload.requestId : undefined;
        if (!isVisionCaptureEnabled()) {
          toast('Voice: click the screen button in the voice controls so I can see your screen.', { icon: '🖥️' });
          setVisionEnabled(false);
          sendScreenshotResult(requestId, null);
          return;
        }
        const dataUrl = await captureScreenForVision();
        if (disposedRef.current) return;
        if (!dataUrl) {
          toast('Voice: screen capture was unavailable.', { icon: '📷' });
          setVisionEnabled(isVisionCaptureEnabled());
        }
        sendScreenshotResult(requestId, dataUrl);
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [enabled, navigate]);

  // Keep the vision toggle in sync with the actual capture stream, and release
  // it on unmount. When the user clicks "Stop sharing" in the browser's own
  // chrome the track ends asynchronously — onVisionCaptureEnded flips the toggle
  // back to OFF so the button doesn't lie. Unmount unsubscribes first (so the
  // caller-initiated disable below doesn't try to setState after teardown) then
  // releases the stream so a forgotten "vision ON" doesn't keep sharing lit.
  useEffect(() => {
    const off = onVisionCaptureEnded(() => setVisionEnabled(false));
    return () => { off(); disableVisionCapture(); };
  }, []);

  // Track whether this tab currently owns proactive voice output. Subscribing
  // fires immediately with the current value, so the indicator is correct on
  // mount without waiting for the next handoff.
  useEffect(() => onVoiceOutputPrimary(setIsVoiceOutputTab), []);

  // Subscribe to shared audio volume/mute preferences across handset & full page.
  useEffect(() => {
    if (typeof onVoiceAudioPrefs !== 'function') return undefined;
    return onVoiceAudioPrefs(setAudioPrefs);
  }, []);

  // Sync visual mode (full sat-phone handset vs compact bar) and transceiver SFX across tabs.
  useEffect(() => {
    const syncVisual = () => setVisualMode(readVoiceVisualMode());
    const syncSfx = () => setSfxEnabled(readTransceiverSfx());
    const onStorage = (e) => {
      if (isVoiceVisualModeStorageEvent(e)) syncVisual();
      if (isTransceiverSfxStorageEvent(e)) syncSfx();
    };
    window.addEventListener(VISUAL_MODE_EVENT, syncVisual);
    window.addEventListener(SFX_EVENT, syncSfx);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(VISUAL_MODE_EVENT, syncVisual);
      window.removeEventListener(SFX_EVENT, syncSfx);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const generativeAvatar = useAvatarMode();
  const floatingFullVisible = enabled && !hidden && !consoleHost && visualMode === 'full';
  const {
    data: floatingAvatarData,
    error: floatingAvatarError,
    updateData: updateFloatingAvatarData,
    refetch: refetchFloatingAvatar,
  } = useAvatarRuntime(floatingFullVisible && floatingAvatar);
  const runningFloatingAvatar = generativeAvatar && !floatingAvatarError && floatingAvatarData?.supported && floatingAvatarData.phase === 'running';

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history]);

  // Track the most recent completed assistant reply so the cascade can detect a
  // destructive-confirmation follow-up ("yes"/"cancel" after a gate prompt) and
  // route it to the server instead of the on-device model.
  useEffect(() => {
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]?.role === 'assistant') { lastAssistantReplyRef.current = history[i].text || ''; return; }
    }
  }, [history]);

  // Fast-resolution cascade executor. Triages one client transcript through
  // trigger → Nano → server and, when a fast tier owns it, executes locally
  // (navigate + speak, or speak). Returns true when handled; false means "send
  // to the server pipeline as usual". Reads config via refs so it stays stable.
  const runFastPath = useCallback(async (text) => {
    if (disposedRef.current) return false;
    const generation = turnGenerationRef.current;
    const fp = fastPathRef.current;
    if (!fp?.enabled) return false;
    // Ensure the nav manifest is loaded (retries if an earlier fetch failed) so
    // tier-1 trigger nav works even when the prefetch didn't land.
    if (fp.triggers) await ensureNavEntries();
    let decision;
    try {
      decision = await resolveTurn(text, {
        fastPath: fp,
        personality: personalityRef.current || {},
        navEntries: navEntriesRef.current,
        dictationActive: dictationActiveRef.current,
        lastAssistantReply: lastAssistantReplyRef.current,
      });
    } catch {
      return false;
    }
    if (disposedRef.current || generation !== turnGenerationRef.current) return true;
    if (decision.tier === TIER.SERVER) return false;

    // A fast tier owns this turn. Stop any lingering playback, speak the reply
    // through the same queue as server TTS, and settle the stage on drain.
    const speak = (line) => {
      if (disposedRef.current) return;
      interrupt();
      setHistory((h) => [...h, { role: 'assistant', text: line }].slice(-MAX_HISTORY));
      setStage('speaking');
      speakSynthesized(line, { ...ttsRef.current, animate: true })
        .catch(() => {})
        .finally(() => whenPlaybackDrained().then(() => {
          if (disposedRef.current) return;
          setStage((c) => (
            ACTIVE_STAGES.has(c) ? c : (isWebSpeechCapturing() ? 'listening' : 'idle')
          ));
        }));
    };

    if (decision.tier === TIER.TRIGGER && decision.kind === 'navigate') {
      navigate(decision.path);
      speak(`Opening ${decision.label}.`);
      return true;
    }
    if (decision.tier === TIER.NANO) {
      speak(decision.reply);
      return true;
    }
    return false;
  }, [navigate, ensureNavEntries]);

  // Proactive CoS speech — the server pushes a `voice:speak` event when the
  // assistant initiates a line (alerts, reminders, briefings). Audio plays
  // automatically via voiceClient; surface a transient toast so the user has
  // visual context for unexpected speech, and append to history so the line
  // shows up in the conversation pane just like a normal assistant reply.
  useEffect(() => {
    if (!enabled) return undefined;
    return onProactiveSpeech(({ sentence, priority }) => {
      if (disposedRef.current) return;
      setHistory((h) => [...h, { role: 'assistant', text: sentence, proactive: true }].slice(-MAX_HISTORY));
      const icon = priority === 'high' ? '🔔' : '🤖';
      toast(`${icon} ${sentence.length > 80 ? `${sentence.slice(0, 80)}…` : sentence}`);
    });
  }, [enabled]);

  const handleStart = useCallback(async () => {
    if (!enabled || disposedRef.current) return;

    // Web Speech API mode — browser handles STT, sends text directly
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
          setHistory((h) => [...h, { role: 'user', text }].slice(-MAX_HISTORY));
          setStage('thinking');
        },
        // routeFinal owns the turn: try the fast-resolution cascade first, and
        // fall through to the server pipeline when no fast tier handles it.
        // Gated on the live ref so toggling fast resolution in Settings takes
        // effect on the next utterance without restarting the recognizer.
        routeFinal: async (text) => {
          if (disposedRef.current) return;
          const generation = turnGenerationRef.current;
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
  }, [enabled, handsFree, useWebSpeech, sttLanguage, runFastPath]);

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

  // Cancel any in-flight capture without submitting — used by the sidebar
  // disengage path so hiding the widget mid-utterance doesn't accidentally
  // ship a partial PTT recording to the LLM. Also drops queued TTS so the
  // bot stops speaking when the user explicitly disengages.
  // Async + awaited teardown: voiceClient holds module-level stream/recorder
  // state, so a synchronous cancel followed by a quick re-engage can have
  // the in-flight stop tear down the *new* capture's tracks. Awaiting the
  // teardown serializes engage/disengage and prevents that race.
  const handleCancel = useCallback(async ({ updateUi = true } = {}) => {
    const canUpdateUi = updateUi && !disposedRef.current;
    if (useWebSpeech) {
      if (isWebSpeechCapturing()) stopWebSpeechCapture();
      if (canUpdateUi) setInterimTranscript('');
    } else {
      if (isContinuous()) await stopContinuous().catch(() => {});
      if (isCapturing()) await stopCapture({ submit: false }).catch(() => {});
    }
    interrupt();
    if (canUpdateUi) setStage('idle');
  }, [useWebSpeech]);

  // Keep the refs the dictation/engage/disengage listeners use pointed at the
  // latest closures. useLayoutEffect (not useEffect) so the refs are updated
  // synchronously after commit — without this, a window event firing in the
  // same tick as `enabled` flipping true could read a stale closure where
  // `enabled` was still false, making the first engage a no-op.
  useLayoutEffect(() => { handleStartRef.current = handleStart; }, [handleStart]);
  useLayoutEffect(() => { handleStopRef.current = handleStop; }, [handleStop]);
  useLayoutEffect(() => { handleCancelRef.current = handleCancel; }, [handleCancel]);

  // Route changes can unmount the widget without changing `enabled`, so the
  // switchable-effect cleanup above is not enough. Invalidate module-level
  // capture callbacks synchronously, then invoke the latest cancel closure for
  // the awaited teardown/interrupt path. The cleanup never updates React state
  // because the owner is already marked disposed.
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      engageSeqRef.current += 1;
      pendingEngageRef.current = false;
      disposeCaptureOwner();
      const teardown = handleCancelRef.current?.({ updateUi: false });
      if (teardown && typeof teardown.then === 'function') {
        cancelInFlightRef.current = teardown;
        teardown.then(
          () => {
            if (cancelInFlightRef.current === teardown) cancelInFlightRef.current = null;
          },
          () => {
            if (cancelInFlightRef.current === teardown) cancelInFlightRef.current = null;
          },
        );
      }
    };
  }, []);

  const handleClear = () => {
    resetConversation();
    setHistory([]);
  };

  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setHistory((h) => [...h, { role: 'user', text }].slice(-MAX_HISTORY));
    setDraft('');
    setStage('thinking');
    // Typed turns run through the same cascade (a typed "go to tasks" navigates
    // instantly). Falls through to the server pipeline when unhandled.
    const generation = turnGenerationRef.current;
    const handled = fastPathRef.current?.enabled ? await runFastPath(text) : false;
    if (disposedRef.current || generation !== turnGenerationRef.current || handled) return;
    sendText(text);
  }, [draft, runFastPath]);

  const toggleCapture = useCallback(() => {
    if (cancelInFlightRef.current) return;
    const active = isWebSpeechCapturing() || isCapturing() || isContinuous();
    playRadioCue(active ? 'tx-end' : 'tx-start', {
      volume: audioPrefs.volume,
      muted: audioPrefs.muted,
      enabled: sfxEnabled,
    });
    if (active) handleStop();
    else handleStart();
  }, [handleStart, handleStop, audioPrefs.volume, audioPrefs.muted, sfxEnabled]);

  const toggleHandsFree = useCallback(() => {
    playRadioCue('click', { volume: audioPrefs.volume, muted: audioPrefs.muted, enabled: sfxEnabled });
    setHandsFree((prev) => {
      const next = !prev;
      safeWriteStorage(HANDS_FREE_KEY, next ? '1' : '0');
      // Discard any in-flight PTT recording — toggling modes mid-utterance
      // shouldn't send a partial turn to the server.
      if (isCapturing()) stopCapture({ submit: false });
      if (isContinuous()) stopContinuous();
      interrupt();
      setStage('idle');
      return next;
    });
  }, [audioPrefs.volume, audioPrefs.muted, sfxEnabled]);

  const handleVolumeChange = useCallback((nextVolume) => {
    setVoiceVolume?.(nextVolume);
  }, []);

  const handleToggleMute = useCallback((explicit) => {
    const next = typeof explicit === 'boolean' ? explicit : !audioPrefs.muted;
    setVoiceMuted?.(next);
    if (!next) {
      playRadioCue('click', { volume: audioPrefs.volume, muted: false, enabled: sfxEnabled });
    }
  }, [audioPrefs.muted, audioPrefs.volume, sfxEnabled]);

  const handleToggleSfx = useCallback(() => {
    const next = !sfxEnabled;
    writeTransceiverSfx(next);
    setSfxEnabled(next);
    if (next) playRadioCue('click', { volume: audioPrefs.volume, muted: audioPrefs.muted, enabled: true });
  }, [sfxEnabled, audioPrefs.volume, audioPrefs.muted]);

  const handleToggleFloatingAvatar = useCallback(() => {
    playRadioCue('click', { volume: audioPrefs.volume, muted: audioPrefs.muted, enabled: sfxEnabled });
    setFloatingAvatar((prev) => {
      const next = !prev;
      safeWriteStorage(DISPLAY_KEY, next ? 'avatar' : 'audio');
      return next;
    });
  }, [audioPrefs.volume, audioPrefs.muted, sfxEnabled]);

  const handleSetVisualMode = useCallback((nextMode) => {
    playRadioCue('click', { volume: audioPrefs.volume, muted: audioPrefs.muted, enabled: sfxEnabled });
    writeVoiceVisualMode(nextMode);
    setVisualMode(nextMode);
  }, [audioPrefs.volume, audioPrefs.muted, sfxEnabled]);

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

  // Poll the VAD's current RMS reading while the hands-free mic is live, or
  // the Web Audio output analyser while the assistant is speaking. Gated on
  // active TX/RX so the interval stays idle at rest, and deadbanded at 0.002.
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

  // Hotkey toggles listening (press once to start, press again to send).
  // Ignored while focus is on an input/textarea so typing isn't hijacked.
  // If the widget is currently hidden, the hotkey also un-hides it so the
  // FAB/sidebar mic icon reflect the live mic state — otherwise the user
  // hears no audio cue and has no UI to confirm the mic is open.
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e) => {
      // Built on the shared predicate the two keyboard hooks use, not a local
      // copy — this is the app-global handler they stand down FOR, so it has to
      // agree with them about what a key is off-limits for. It drops auto-repeat,
      // any editable target (SELECT included, where the default Space hotkey
      // would otherwise open the mic instead of the element's own dropdown), and
      // Space on a focused button, which must ACTIVATE it: preventDefault-ing
      // there would swallow every keyboard button press in the app and open the
      // mic instead (e.g. the POST cognitive drills' Start / Match buttons).
      if (!isPushToTalkKey(e, hotkey)) return;
      e.preventDefault();
      // writeVoiceHidden dispatches VISIBILITY_EVENT, which the listener
      // below syncs into local `hidden` — no explicit setHidden needed.
      if (hidden) writeVoiceHidden(false);
      toggleCapture();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, hotkey, hidden, toggleCapture]);

  // Settings → Voice can toggle widget visibility without a reload. Listen for
  // the custom event and the storage event (covers other tabs).
  useEffect(() => {
    const sync = () => setHidden(readVoiceHidden());
    const onStorage = (e) => { if (isVoiceHiddenStorageEvent(e)) sync(); };
    window.addEventListener(VISIBILITY_EVENT, sync);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(VISIBILITY_EVENT, sync);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Sidebar Voice toggle dispatches engage/disengage so engaging the widget
  // also starts listening (and disengaging stops the mic) — without this the
  // user would have to click the toggle, then click mic separately.
  // Disengage routes through handleCancel (not handleStop) so a PTT user who
  // hides the widget mid-recording doesn't have a partial utterance shipped
  // to the LLM by stopCapture's default `{ submit: true }` behavior.
  // Engage uses a pending-flag fallback: if it lands while voice is disabled
  // (handleStart short-circuits while !enabled), we replay the engage in the
  // effect below once enabled flips.
  // Engage also awaits any in-flight cancel — voiceClient's module-level
  // stream/recorder means a rapid disengage→engage can otherwise let the
  // pending teardown stop tracks from the new capture.
  // A start requested while this chunk was still loading is held by the gate
  // and claimed here, through the same engage path, along with a Daily Log
  // dictation that began in that window (its `voice:dictation` event is not
  // repeated). The claim waits one microtask: StrictMode's simulated unmount
  // runs between two synchronous mounts and cancels capture, so a claim made
  // in the first mount would be consumed and then dropped.
  useEffect(() => {
    let live = true;
    const onEngage = async () => {
      const seq = ++engageSeqRef.current;
      if (cancelInFlightRef.current) await cancelInFlightRef.current;
      if (!live || seq !== engageSeqRef.current) return;
      if (!enabled) {
        pendingEngageRef.current = true;
        return;
      }
      handleStartRef.current?.();
    };
    const onDisengage = () => {
      engageSeqRef.current += 1;
      pendingEngageRef.current = false;
      const p = handleCancelRef.current?.();
      if (p && typeof p.then === 'function') {
        cancelInFlightRef.current = p;
        p.finally(() => {
          if (cancelInFlightRef.current === p) cancelInFlightRef.current = null;
        });
      }
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
  }, [enabled, claimHeld]);

  // Drain a queued engage once voice is actually on. Without this, an engage
  // that beat the enable would show the widget but leave the mic dormant.
  // Await any in-flight cancel first to keep engage/disengage serialized.
  useEffect(() => {
    if (!enabled || !pendingEngageRef.current) return;
    pendingEngageRef.current = false;
    (async () => {
      if (cancelInFlightRef.current) await cancelInFlightRef.current;
      handleStartRef.current?.();
    })();
  }, [enabled]);

  // Reuse handleCancel for teardown so we don't duplicate the awaited stop
  // logic — same race-with-re-engage concern applies if the user hides then
  // immediately re-engages from the sidebar.
  const hideWidget = useCallback(async () => {
    await handleCancel();
    writeVoiceHidden(true);
    // Hand focus to the sidebar toggle (which stays mounted and now offers
    // re-engage) before this widget unmounts, else it drops to document.body.
    const target = document.querySelector('[data-voice-toggle]') || document.getElementById('main-content');
    target?.focus();
    setHidden(true);
    toast('Voice widget hidden. Re-enable from the sidebar mic or Settings → Voice.');
  }, [handleCancel]);

  useLayoutEffect(() => {
    const next = pendingFocusRef.current;
    if (!next) return;
    pendingFocusRef.current = null;
    (next === 'input' ? inputRef : fabRef).current?.focus();
  }, [expanded]);

  const sampleRef = useRef(null);
  const stopSample = useCallback(() => {
    const sample = sampleRef.current;
    if (!sample) return false;
    sampleRef.current = null;
    sample.abort();
    return true;
  }, []);
  const playCallSample = async () => {
    if (stage !== 'idle' || sampleRef.current) return;
    prepareVoicePlayback();
    const sample = new AbortController();
    sampleRef.current = sample;
    setStage('thinking');
    try {
      const queued = await speakSynthesized('PortOS radio check. One, two, three. How do you read me?', {
        ...ttsRef.current, signal: sample.signal, animate: true,
      });
      if (!queued || sampleRef.current !== sample) return;
      setStage('speaking');
      await whenPlaybackDrained();
    } catch (err) {
      if (sampleRef.current === sample) toast.error(`Voice sample: ${err.message}`);
    } finally {
      if (sampleRef.current === sample) {
        sampleRef.current = null;
        setStage('idle');
      }
    }
  };

  const sendFromConsole = () => {
    if (!draft.trim()) return;
    if (stopSample()) interrupt();
    prepareVoicePlayback();
    handleSend();
  };

  const toggleConsoleMic = () => {
    if (stopSample()) interrupt();
    prepareVoicePlayback();
    toggleCapture();
  };

  const endCall = useCallback(() => {
    stopSample();
    turnGenerationRef.current += 1;
    engageSeqRef.current += 1;
    pendingEngageRef.current = false;
    // Stop even a pending permission request or an unsent push-to-talk turn.
    disposeCaptureOwner();
    disableVisionCapture();
    interrupt();
    setInterimTranscript('');
    setStage('idle');
  }, [stopSample]);

  useEffect(() => () => { stopSample(); }, [stopSample]);

  // Leaving the dedicated call console stops its microphone and cancels
  // playback; switching surfaces never mounts a second capture engine.
  const previousConsole = useRef(null);
  useEffect(() => {
    if (previousConsole.current && !consoleHost) endCall();
    previousConsole.current = consoleHost;
  }, [consoleHost, endCall]);

  if (!enabled) return null;
  if (consoleHost) {
    return createPortal(
      <VoiceCallConsole
        stage={stage}
        history={history}
        scrollRef={scrollRef}
        interimTranscript={interimTranscript}
        capturing={ACTIVE_STAGES.has(stage) || isWebSpeechCapturing()}
        handsFree={!useWebSpeech && handsFree}
        canChangeMicMode={!useWebSpeech}
        hotkey={hotkey}
        draft={draft}
        onDraft={setDraft}
        onSend={sendFromConsole}
        onMic={toggleConsoleMic}
        onMode={toggleHandsFree}
        onInterrupt={() => (sampleRef.current ? endCall() : interrupt())}
        onEnd={endCall}
        onSample={playCallSample}
        onClear={handleClear}
        voiceLabel={tts?.voice || tts?.engine}
        volume={audioPrefs.volume}
        muted={audioPrefs.muted}
        onVolumeChange={handleVolumeChange}
        onToggleMute={handleToggleMute}
        sfxEnabled={sfxEnabled}
        onToggleSfx={handleToggleSfx}
        signalLevel={level}
        visionEnabled={visionEnabled}
        onToggleVision={toggleVision}
      />,
      consoleHost,
    );
  }
  if (hidden) return null;

  const { icon: Icon, label, tone } = STAGE[stage] || STAGE.idle;
  const capturing = ACTIVE_STAGES.has(stage) || isWebSpeechCapturing();
  // Distinct secondary-accent ring + soft glow so the floating compact pill reads
  // as "voice agent layer" instead of blending into whatever card it's covering.
  const fabSurface = 'border-port-accent-2/50 shadow-[0_0_24px_-4px_rgba(168,85,247,0.55)]';
  // Anchor in the bottom-left corner of the workspace, clearing the fixed desktop sidebar.
  const leftOffsetClass = desktopNav
    ? (sidebarCollapsed ? 'left-20' : 'left-[17rem]')
    : 'left-4';

  return (
    // data-voice-widget marker is used by client/src/services/domIndex.js
    // TEXT_EXCLUDE_SELECTORS to keep the widget's own conversation transcript
    // out of the ui_read visible-text snapshot — otherwise the voice agent
    // would "read the page" and recite its own dialog back to the user.
    <aside
      data-voice-widget
      aria-label="Voice assistant"
      className={`fixed bottom-4 z-50 flex flex-col items-start gap-2 transition-[left] duration-300 ${leftOffsetClass}`}
    >
      {!expanded && (
        <div className="md:hidden flex items-center gap-2">
          <button
            type="button"
            ref={fabRef}
            onClick={() => { pendingFocusRef.current = 'input'; setExpanded(true); toggleCapture(); }}
            className={`p-3 rounded-full border transition-colors ${fabSurface} ${
              capturing
                ? 'bg-port-accent-2 text-port-on-accent-2 animate-pulse'
                : 'bg-port-card text-port-text'
            }`}
            title="Open voice controls"
            aria-label="Open voice controls"
          >
            <Icon size={20} />
          </button>
          <button
            type="button"
            onClick={hideWidget}
            title="Hide voice widget (restore from the sidebar or Settings → Voice)"
            aria-label="Hide voice widget"
            className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full bg-port-card border text-port-text-muted hover:text-port-text ${fabSurface}`}
          >
            <EyeOff size={14} />
          </button>
          {capturing && (
            <span role="status" className={`text-xs ${tone} bg-port-card/95 backdrop-blur border rounded-full px-2 py-1 ${fabSurface}`}>
              {label}
            </span>
          )}
        </div>
      )}

      {visualMode === 'full' ? (
        <div className={`${expanded ? 'flex' : 'hidden'} md:flex flex-col items-start gap-2`}>
          {dictationActive && (
            <div role="status" className="flex items-center gap-2 bg-port-accent/15 border border-port-accent/40 rounded-full px-3 py-1 text-xs text-port-accent shadow-lg">
              <NotebookPen size={12} className="animate-pulse" />
              Dictating to Daily Log — say &quot;stop dictation&quot; to end
            </div>
          )}
          <SatPhoneHandset
            variant="floating"
            stage={stage}
            history={history}
            scrollRef={scrollRef}
            interimTranscript={interimTranscript}
            capturing={capturing}
            handsFree={handsFree}
            canChangeMicMode={!useWebSpeech}
            hotkey={hotkey}
            draft={draft}
            onDraft={setDraft}
            onSend={sendFromConsole}
            onMic={toggleConsoleMic}
            onMode={toggleHandsFree}
            onInterrupt={() => (sampleRef.current ? endCall() : interrupt())}
            onEnd={endCall}
            onSample={playCallSample}
            onClear={handleClear}
            voiceLabel={tts?.voice || tts?.engine}
            avatar={floatingAvatar}
            onToggleAvatar={handleToggleFloatingAvatar}
            avatarData={floatingAvatarData}
            avatarError={floatingAvatarError}
            onUpdateAvatarData={updateFloatingAvatarData}
            onRefetchAvatar={refetchFloatingAvatar}
            runningAvatar={runningFloatingAvatar}
            volume={audioPrefs.volume}
            muted={audioPrefs.muted}
            onVolumeChange={handleVolumeChange}
            onToggleMute={handleToggleMute}
            sfxEnabled={sfxEnabled}
            onToggleSfx={handleToggleSfx}
            signalLevel={level}
            visionEnabled={visionEnabled}
            onToggleVision={toggleVision}
            isVoiceOutputTab={isVoiceOutputTab}
            onClaimVoiceOutput={() => { if (!isVoiceOutputTab) claimVoiceOutput(); }}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((c) => !c)}
            conversationId={conversationId}
            inputRef={inputRef}
            onCompactMode={() => handleSetVisualMode('compact')}
            onHideWidget={hideWidget}
            onMinimizeMobile={() => { pendingFocusRef.current = 'fab'; setExpanded(false); }}
          />
        </div>
      ) : (
        <div className={`${expanded ? 'flex' : 'hidden'} md:flex flex-col items-start gap-2 w-96 max-w-[calc(100vw-2rem)]`}>
          {!collapsed && history.length > 0 && (
            <div id={conversationId} className={`bg-port-card/95 backdrop-blur border rounded-xl w-full flex flex-col ${fabSurface}`}>
              <div className="flex items-center justify-between px-3 py-1.5 border-b border-port-border/50">
                <span className="text-xs text-port-text-muted">Conversation</span>
                <button
                  type="button"
                  onClick={handleClear}
                  title="Clear conversation"
                  aria-label="Clear conversation"
                  className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1 rounded text-port-text-muted hover:text-port-error hover:bg-port-error/10"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              <div ref={scrollRef} className="text-xs p-3 space-y-2 overflow-y-auto max-h-80">
                {/* Only finalized turns are announced; the interim line below churns per word. */}
                <div role="log" aria-live="polite" aria-label="Conversation" className="space-y-2">
                  {history.map((turn, i) => (
                    <div key={i} className={turn.role === 'user' ? 'text-port-text-muted' : 'text-port-text'}>
                      <span className="text-[10px] uppercase tracking-wide opacity-60 mr-2">
                        {turn.role === 'user' ? 'you' : 'assistant'}
                      </span>
                      {turn.text}
                    </div>
                  ))}
                </div>
                {interimTranscript && (
                  <div aria-hidden="true" className="text-port-text-muted italic">
                    <span className="text-[10px] uppercase tracking-wide opacity-60 mr-2">you</span>
                    {interimTranscript}
                  </div>
                )}
              </div>
            </div>
          )}
          <form
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
            className={`flex items-center gap-1 bg-port-card/95 backdrop-blur border rounded-full pl-4 pr-1 py-1 w-full focus-within:border-port-accent ${fabSurface}`}
          >
            <input
              ref={inputRef}
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Type a message…"
              aria-label="Message to the voice assistant"
              className="flex-1 bg-transparent text-sm text-port-text placeholder:text-port-text-muted focus:outline-none"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              title="Send text (Enter)"
              aria-label="Send text"
              className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-port-text-muted"
            >
              <Send size={14} />
            </button>
          </form>
          {dictationActive && (
            <div role="status" className="flex items-center gap-2 bg-port-accent/15 border border-port-accent/40 rounded-full px-3 py-1 text-xs text-port-accent shadow-lg">
              <NotebookPen size={12} className="animate-pulse" />
              Dictating to Daily Log — say &quot;stop dictation&quot; to end
            </div>
          )}
          <div className={`flex flex-col gap-1.5 bg-port-card/95 backdrop-blur border rounded-2xl p-2 w-full ${fabSurface}`}>
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1 min-w-0">
                <button
                  type="button"
                  onClick={() => handleSetVisualMode('full')}
                  title="Show satellite transceiver handset (saved in preferences)"
                  aria-label="Show transceiver handset"
                  className="satphone-key inline-flex items-center gap-1 px-2.5 py-1 rounded-full border text-[10px] pointer-coarse:min-h-11 font-mono font-semibold uppercase tracking-wider text-port-accent-text"
                >
                  <Radio size={12} aria-hidden="true" />
                  Handset
                </button>
                <Link
                  to="/voice/call"
                  title="Open full-page Voice Call station"
                  aria-label="Open full-page Voice Call"
                  className="inline-flex items-center justify-center p-1.5 rounded-full pointer-coarse:min-h-11 pointer-coarse:min-w-11 text-port-text-muted hover:text-port-text hover:bg-port-border/70"
                >
                  <Maximize2 size={12} aria-hidden="true" />
                </Link>
                {label && <span role="status" className={`text-xs truncate ${tone}`} title={label}>{label}</span>}
                {!label && <span role="status" className="sr-only">Standby</span>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!useWebSpeech && handsFree && isContinuous() && (
                  <span
                    className="inline-flex items-center text-port-accent"
                    title={`mic level ${level.toFixed(3)}`}
                  >
                    <MicroGlyph variant="signal" size={18} level={level} state="accent" />
                  </span>
                )}
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCollapsed((c) => !c)}
                    aria-expanded={!collapsed}
                    aria-controls={conversationId}
                    title={collapsed ? 'Show conversation' : 'Hide conversation'}
                    aria-label={collapsed ? 'Show conversation' : 'Hide conversation'}
                    className="min-h-[44px] min-w-[44px] pointer-fine:min-h-0 pointer-fine:min-w-0 inline-flex items-center justify-center p-1.5 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70"
                  >
                    {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                )}
                {stage === 'speaking' && (
                  <button
                    type="button"
                    onClick={interrupt}
                    title="Interrupt"
                    aria-label="Interrupt"
                    className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full text-port-error hover:bg-port-error/10"
                  >
                    <Square size={14} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleCapture}
                  aria-pressed={capturing}
                  className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-2 rounded-full transition-colors ${
                    capturing
                      ? 'bg-port-accent-2 text-port-on-accent-2 animate-pulse'
                      : 'bg-port-accent-2/20 hover:bg-port-accent-2/40 text-port-accent-2'
                  }`}
                  title={(() => {
                    if (handsFree) {
                      return capturing
                        ? `Click or press ${hotkey} to stop hands-free listening`
                        : `Click or press ${hotkey} to start hands-free listening`;
                    }
                    return capturing
                      ? `Click or press ${hotkey} to send`
                      : `Click or press ${hotkey} to listen`;
                  })()}
                  aria-label={handsFree
                    ? (capturing ? 'Stop hands-free listening' : 'Start hands-free listening')
                    : (capturing ? 'Send voice message' : 'Start listening')}
                >
                  <Icon size={15} />
                </button>
                <button
                  type="button"
                  onClick={() => { pendingFocusRef.current = 'fab'; setExpanded(false); }}
                  title="Minimize voice controls"
                  aria-label="Minimize voice controls"
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 md:hidden p-1.5 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70"
                >
                  <X size={14} />
                </button>
                <button
                  type="button"
                  onClick={hideWidget}
                  title="Hide voice widget (restore from the sidebar or Settings → Voice)"
                  aria-label="Hide voice widget"
                  className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 p-1.5 rounded-full text-port-text-muted hover:text-port-text hover:bg-port-border/70"
                >
                  <EyeOff size={14} />
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1 border-t border-port-border/50 pt-1.5">
              {!useWebSpeech && (
                <button
                  type="button"
                  onClick={toggleHandsFree}
                  aria-pressed={handsFree}
                  title={handsFree
                    ? 'Hands-free ON — mic stays open, auto-submits on pause, talk over the bot to interrupt. Click to switch to push-to-talk.'
                    : 'Push-to-talk ON — click mic to start, click again to send. Click to switch to hands-free.'}
                  className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] pointer-coarse:min-h-11 font-medium ${handsFree
                    ? 'text-port-accent-text bg-port-accent/10 hover:bg-port-accent/20'
                    : 'text-port-text-muted hover:text-port-text hover:bg-port-border/70'}`}
                >
                  <InfinityIcon size={12} />
                  {handsFree ? 'hands-free' : 'push-to-talk'}
                </button>
              )}
              <button
                type="button"
                onClick={toggleVision}
                aria-label={visionEnabled ? 'Disable screen vision for voice' : 'Enable screen vision for voice'}
                aria-pressed={visionEnabled}
                title={visionEnabled
                  ? 'Screen vision ON — the assistant can describe what\'s on your screen ("what\'s on this chart?"). Click to stop sharing.'
                  : 'Screen vision OFF — click to let the assistant see your screen for "what\'s on this chart?" (you pick the tab/window).'}
                className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] pointer-coarse:min-h-11 font-medium ${visionEnabled
                  ? 'text-port-accent-text bg-port-accent/10 hover:bg-port-accent/20'
                  : 'text-port-text-muted hover:text-port-text hover:bg-port-border/70'}`}
              >
                {visionEnabled ? <Monitor size={12} /> : <MonitorOff size={12} />}
                {visionEnabled ? 'vision' : 'no vision'}
              </button>
              <button
                type="button"
                onClick={() => { if (!isVoiceOutputTab) claimVoiceOutput(); }}
                aria-pressed={isVoiceOutputTab}
                title={isVoiceOutputTab
                  ? 'This tab plays the assistant\'s proactive speech (reminders, briefings). Only one tab speaks at a time.'
                  : 'Proactive speech plays on another tab. Click to make this tab the speaker.'}
                className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] pointer-coarse:min-h-11 font-medium ${isVoiceOutputTab
                  ? 'text-port-success-text bg-port-success/10'
                  : 'text-port-text-muted hover:text-port-text hover:bg-port-border/70'}`}
              >
                {isVoiceOutputTab ? <Volume2 size={12} /> : <VolumeX size={12} />}
                {isVoiceOutputTab ? 'speaker' : 'muted'}
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
