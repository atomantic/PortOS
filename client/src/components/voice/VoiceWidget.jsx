import { useState, useEffect, useRef, useCallback } from 'react';
import { Mic, MicOff, Brain, Volume2, Square, Trash2, ChevronDown, ChevronUp, Send, Infinity as InfinityIcon } from 'lucide-react';
import {
  startCapture, stopCapture, interrupt, resetConversation, sendText, onVoiceEvent, isCapturing,
  startContinuous, stopContinuous, isContinuous, whenPlaybackDrained, getVadLevel,
  webSpeechSupported, startWebSpeechCapture, stopWebSpeechCapture, isWebSpeechCapturing,
} from '../../services/voiceClient';
import { getVoiceConfig } from '../../services/apiVoice';
import toast from '../ui/Toast';

// Peak below this (0..1) is usually whisper's [BLANK_AUDIO] territory.
const QUIET_MIC_THRESHOLD = 0.02;

const HANDS_FREE_KEY = 'portos.voice.handsFree';

const STAGE = {
  idle: { icon: Mic, label: '', tone: 'text-gray-300' },
  listening: { icon: MicOff, label: 'Listening… (click to send)', tone: 'text-port-accent' },
  handsfree: { icon: MicOff, label: 'Hands-free — speak anytime', tone: 'text-port-accent' },
  capturing: { icon: MicOff, label: 'Capturing your voice…', tone: 'text-port-accent animate-pulse' },
  thinking: { icon: Brain, label: 'Thinking…', tone: 'text-yellow-400' },
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

export default function VoiceWidget() {
  const [enabled, setEnabled] = useState(false);
  const [hotkey, setHotkey] = useState('Space');
  const [sttEngine, setSttEngine] = useState('whisper');
  const [sttLanguage, setSttLanguage] = useState('en');
  const [stage, setStage] = useState('idle');
  const [history, setHistory] = useState([]);
  const [collapsed, setCollapsed] = useState(false);
  const [draft, setDraft] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [handsFree, setHandsFree] = useState(() => {
    if (typeof window === 'undefined') return true;
    const stored = window.localStorage.getItem(HANDS_FREE_KEY);
    return stored === null ? true : stored === '1';
  });
  const [level, setLevel] = useState(0);
  const scrollRef = useRef(null);
  const useWebSpeech = sttEngine === 'web-speech' && webSpeechSupported;

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

  useEffect(() => {
    getVoiceConfig()
      .then((cfg) => {
        setEnabled(!!cfg?.enabled);
        setHotkey(cfg?.hotkey || 'Space');
        if (cfg?.stt?.engine) setSttEngine(cfg.stt.engine);
        if (cfg?.stt?.language) setSttLanguage(cfg.stt.language);
      })
      .catch(() => {});
    // Settings → Voice writes via PUT /api/voice/config and the route broadcasts
    // voice:config:changed — keep the widget's enabled/engine/hotkey in sync so
    // toggling voice mode mid-session takes effect without a reload.
    const off = onVoiceEvent('voice:config:changed', (cfg) => {
      if (typeof cfg?.enabled === 'boolean') setEnabled(cfg.enabled);
      if (cfg?.hotkey) setHotkey(cfg.hotkey);
      if (cfg?.sttEngine) setSttEngine(cfg.sttEngine);
      if (cfg?.sttLanguage) setSttLanguage(cfg.sttLanguage);
    });
    return off;
  }, []);

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
        // voice:idle fires when the server finishes *sending* TTS; local
        // playback may still be running. Wait for drain so stage doesn't
        // flip off 'speaking' while audio is still playing.
        if (d?.reason === 'reset') setHistory([]);
        whenPlaybackDrained().then(() => {
          setStage((current) => (ACTIVE_STAGES.has(current) ? current : restState()));
        });
      }),
      onVoiceEvent('voice:error', (d) => {
        toast.error(`Voice: ${d.message}`);
        setStage(restState());
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [enabled]);

  // Auto-scroll to bottom on new content
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history]);

  const handleStart = useCallback(async () => {
    if (!enabled) return;

    // Web Speech API mode — browser handles STT, sends text directly
    if (useWebSpeech) {
      if (isWebSpeechCapturing()) return;
      setStage('listening');
      setInterimTranscript('');
      startWebSpeechCapture({
        language: sttLanguage,
        onInterim: (text) => setInterimTranscript(text),
        onFinal: (text) => {
          setInterimTranscript('');
          setHistory((h) => [...h, { role: 'user', text }].slice(-MAX_HISTORY));
          setStage('thinking');
        },
        onError: (err) => {
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
        onSpeechStart: () => setStage('capturing'),
        onSpeechEnd: () => setStage('thinking'),
        onSubmit: ({ submitted, peak }) => {
          if (!submitted) {
            setStage('handsfree');
            return;
          }
          warnIfQuiet(peak);
        },
      }).catch((err) => {
        toast.error(`Mic: ${err.message}`);
        setStage('idle');
      });
      return;
    }
    if (isCapturing()) return;
    setStage('listening');
    await startCapture().catch((err) => {
      toast.error(`Mic: ${err.message}`);
      setStage('idle');
    });
  }, [enabled, handsFree, useWebSpeech, sttLanguage]);

  const handleStop = useCallback(async () => {
    if (useWebSpeech) {
      stopWebSpeechCapture();
      setInterimTranscript('');
      setStage('idle');
      return;
    }
    if (handsFree && isContinuous()) {
      await stopContinuous();
      setStage('idle');
      return;
    }
    if (!isCapturing()) return;
    setStage('thinking');
    const r = await stopCapture().catch((err) => {
      toast.error(`Mic: ${err.message}`);
      setStage('idle');
      return null;
    });
    if (!r) {
      setStage('idle');
      return;
    }
    warnIfQuiet(r.peak);
  }, [handsFree, useWebSpeech]);

  const handleClear = () => {
    resetConversation();
    setHistory([]);
  };

  const handleSend = useCallback(() => {
    const text = draft.trim();
    if (!text) return;
    setHistory((h) => [...h, { role: 'user', text }].slice(-MAX_HISTORY));
    sendText(text);
    setDraft('');
    setStage('thinking');
  }, [draft]);

  const toggleCapture = useCallback(() => {
    if (isWebSpeechCapturing() || isCapturing() || isContinuous()) handleStop();
    else handleStart();
  }, [handleStart, handleStop]);

  const toggleHandsFree = useCallback(() => {
    setHandsFree((prev) => {
      const next = !prev;
      window.localStorage.setItem(HANDS_FREE_KEY, next ? '1' : '0');
      // Discard any in-flight PTT recording — toggling modes mid-utterance
      // shouldn't send a partial turn to the server.
      if (isCapturing()) stopCapture({ submit: false });
      if (isContinuous()) stopContinuous();
      interrupt();
      setStage('idle');
      return next;
    });
  }, []);

  // Poll the VAD's current RMS reading while the hands-free mic is live.
  // Gated on stage !== 'idle' so the interval doesn't tick when the mic is off,
  // and the setLevel updater is guarded so jitter below ~0.002 doesn't re-render.
  const pollLevel = handsFree && stage !== 'idle';
  useEffect(() => {
    if (!pollLevel) return undefined;
    const id = setInterval(() => {
      const v = getVadLevel();
      setLevel((prev) => (Math.abs(prev - v) > 0.002 ? v : prev));
    }, 100);
    return () => clearInterval(id);
  }, [pollLevel]);

  // Hotkey toggles listening (press once to start, press again to send).
  // Ignored while focus is on an input/textarea so typing isn't hijacked.
  useEffect(() => {
    if (!enabled) return;
    const isTypingTarget = (el) => {
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
    };
    const onKey = (e) => {
      if (e.code !== hotkey || e.repeat) return;
      if (isTypingTarget(document.activeElement)) return;
      e.preventDefault();
      toggleCapture();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, hotkey, toggleCapture]);

  if (!enabled) return null;

  const { icon: Icon, label, tone } = STAGE[stage] || STAGE.idle;
  const capturing = ACTIVE_STAGES.has(stage) || isWebSpeechCapturing();

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2 w-96 max-w-[calc(100vw-2rem)]">
      {!collapsed && history.length > 0 && (
        <div className="bg-port-card/95 backdrop-blur border border-port-border rounded-xl shadow-lg w-full flex flex-col">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-port-border/50">
            <span className="text-xs text-gray-400">Conversation</span>
            <button
              onClick={handleClear}
              title="Clear conversation"
              className="p-1 rounded text-gray-400 hover:text-port-error hover:bg-port-error/10"
            >
              <Trash2 size={12} />
            </button>
          </div>
          <div ref={scrollRef} className="text-xs p-3 space-y-2 overflow-y-auto max-h-80">
            {history.map((turn, i) => (
              <div key={i} className={turn.role === 'user' ? 'text-gray-400' : 'text-white'}>
                <span className="text-[10px] uppercase tracking-wide opacity-60 mr-2">
                  {turn.role === 'user' ? 'you' : 'assistant'}
                </span>
                {turn.text}
              </div>
            ))}
            {interimTranscript && (
              <div className="text-gray-500 italic">
                <span className="text-[10px] uppercase tracking-wide opacity-60 mr-2">you</span>
                {interimTranscript}
              </div>
            )}
          </div>
        </div>
      )}
      <form
        onSubmit={(e) => { e.preventDefault(); handleSend(); }}
        className="flex items-center gap-1 bg-port-card/95 backdrop-blur border border-port-border rounded-full pl-4 pr-1 py-1 shadow-lg w-full"
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message…"
          className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          title="Send text (Enter)"
          className="p-2 rounded-full text-gray-400 hover:text-white hover:bg-port-border/70 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400"
        >
          <Send size={14} />
        </button>
      </form>
      <div className="flex items-center gap-2 bg-port-card/95 backdrop-blur border border-port-border rounded-full pl-3 pr-1 py-1 shadow-lg">
        <span className={`text-xs ${tone}`}>{label}</span>
        {!useWebSpeech && handsFree && isContinuous() && (
          <span
            className="w-1.5 rounded-full bg-port-accent transition-all"
            style={{ height: `${Math.min(20, 4 + level * 120)}px` }}
            title={`mic level ${level.toFixed(3)}`}
          />
        )}
        {!useWebSpeech && (
          <button
            onClick={toggleHandsFree}
            title={handsFree
              ? 'Hands-free ON — mic stays open, auto-submits on pause, talk over the bot to interrupt. Click to switch to push-to-talk.'
              : 'Push-to-talk ON — click mic to start, click again to send. Click to switch to hands-free.'}
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium ${handsFree
              ? 'text-port-accent bg-port-accent/10 hover:bg-port-accent/20'
              : 'text-gray-400 hover:text-white hover:bg-port-border/70'}`}
          >
            <InfinityIcon size={12} />
            {handsFree ? 'hands-free' : 'push-to-talk'}
          </button>
        )}
        {history.length > 0 && (
          <button
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Show conversation' : 'Hide conversation'}
            className="p-1.5 rounded-full text-gray-400 hover:text-white hover:bg-port-border/70"
          >
            {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
          </button>
        )}
        {stage === 'speaking' && (
          <button
            onClick={interrupt}
            title="Interrupt"
            className="p-2 rounded-full text-port-error hover:bg-port-error/10"
          >
            <Square size={14} />
          </button>
        )}
        <button
          onClick={toggleCapture}
          className={`p-3 rounded-full transition-colors ${
            capturing
              ? 'bg-port-accent text-white animate-pulse'
              : 'bg-port-border hover:bg-port-border/70 text-white'
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
        >
          <Icon size={16} />
        </button>
      </div>
    </div>
  );
}
