/**
 * FableLoom Mobile Audience Join View (#5383).
 *
 * Standalone mobile-optimized interface for guest audience devices.
 * Connects to the dedicated `/fableloom-hosted` Socket.IO namespace using
 * the short-lived scoped token extracted from the URL fragment (`#session=...&token=...`).
 */

import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  Radio,
  Send,
  Smartphone,
  Volume2,
  VolumeX,
} from 'lucide-react';

export default function FableLoomHostedJoin() {
  const [sessionId, setSessionId] = useState(null);
  const [token, setToken] = useState(null);
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [sessionState, setSessionState] = useState(null);
  const [turnPhase, setTurnPhase] = useState('idle'); // 'idle' | 'listening' | 'thinking' | 'speaking' | 'ended'
  const [transcript, setTranscript] = useState([]);
  const [textInput, setTextInput] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [micAllowed, setMicAllowed] = useState(null);

  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const transcriptScrollRef = useRef(null);
  const audioPlayerRef = useRef(null);

  // 1. Parse session and token from URL fragment (#session=...&token=...)
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    const params = new URLSearchParams(hash);
    const sId = params.get('session');
    const tok = params.get('token');

    if (!sId || !tok) {
      setAuthError('Invalid or missing join credentials in QR link.');
      return;
    }

    setSessionId(sId);
    setToken(tok);
  }, []);

  // 2. Connect to dedicated /fableloom-hosted Socket.IO namespace
  useEffect(() => {
    if (!sessionId || !token) return;

    const s = io('/fableloom-hosted', {
      auth: { sessionId, token, role: 'audience' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
    });

    s.on('connect', () => {
      setConnected(true);
      setAuthError(null);
    });

    s.on('connect_error', (err) => {
      setConnected(false);
      setAuthError(err?.message || 'Failed to authenticate with hosted session.');
    });

    s.on('hosted:session:sync', (state) => {
      setSessionState(state);
      setTurnPhase(state.turnPhase || 'idle');
      if (Array.isArray(state.transcript)) {
        setTranscript(state.transcript);
      }
    });

    s.on('hosted:turn:phase', (data) => {
      setTurnPhase(data.phase || 'idle');
      if (data.phase === 'thinking') {
        setIsRecording(false);
      }
    });

    s.on('hosted:turn:transcript', (item) => {
      setTranscript((prev) => [...prev, item]);
    });

    s.on('hosted:turn:tts', (data) => {
      // If audio target is audience, play the TTS audio locally on the phone
      if (data.target === 'audience' && data.audio) {
        try {
          const audioUrl = `data:${data.mimeType || 'audio/wav'};base64,${data.audio}`;
          if (audioPlayerRef.current) {
            audioPlayerRef.current.src = audioUrl;
            audioPlayerRef.current.play().catch(() => null);
          }
        } catch (err) {
          console.warn('Audio playback error:', err);
        }
      }
    });

    s.on('hosted:story:transition', (data) => {
      setSessionState((prev) => (prev ? {
        ...prev,
        currentNodeId: data.node?.id,
        playbackPhase: data.playbackPhase,
      } : prev));
    });

    s.on('hosted:session:ended', (data) => {
      setTurnPhase('ended');
      setAuthError(data?.reason === 'host_ended' ? 'The host has ended this play session.' : 'Session ended.');
    });

    setSocket(s);

    return () => {
      s.disconnect();
    };
  }, [sessionId, token]);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptScrollRef.current) {
      transcriptScrollRef.current.scrollTop = transcriptScrollRef.current.scrollHeight;
    }
  }, [transcript]);

  // Microphone recording controls
  const startRecording = async () => {
    if (turnPhase === 'thinking' || turnPhase === 'speaking') return;
    try {
      audioChunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setMicAllowed(true);

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        audioBlob.arrayBuffer().then((buf) => {
          if (socket) {
            socket.emit('hosted:mic:stop', new Uint8Array(buf));
          }
        });
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.start(100);
      setIsRecording(true);

      if (socket) {
        socket.emit('hosted:mic:start');
      }
    } catch (err) {
      console.error('Microphone access denied:', err);
      setMicAllowed(false);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const handleSendText = (e) => {
    e?.preventDefault();
    if (!textInput.trim() || !socket) return;
    socket.emit('hosted:turn:text', { text: textInput.trim() });
    setTextInput('');
  };

  if (authError) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-6 text-center">
        <div className="w-16 h-16 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mb-4">
          <AlertCircle className="w-8 h-8 text-red-400" />
        </div>
        <h1 className="text-xl font-bold mb-2">Hosted Play Error</h1>
        <p className="text-slate-400 text-sm max-w-xs">{authError}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col justify-between max-w-md mx-auto relative overflow-hidden shadow-2xl">
      <audio ref={audioPlayerRef} className="hidden" />

      {/* Header */}
      <header className="px-5 py-4 border-b border-slate-800/80 bg-slate-900/50 backdrop-blur flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Smartphone className="w-5 h-5 text-indigo-400" />
          <div>
            <h1 className="text-sm font-semibold text-white leading-none">FableLoom Play</h1>
            <p className="text-[11px] text-slate-400 mt-0.5">Audience Microphone UI</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-800 border border-slate-700 text-[11px]">
          <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
          <span className="text-slate-300 font-medium">{connected ? 'Connected' : 'Connecting…'}</span>
        </div>
      </header>

      {/* Live Turn Phase Banner */}
      <div className="px-4 py-2.5 border-b border-slate-800 bg-slate-900/30 flex items-center justify-center">
        {turnPhase === 'listening' ? (
          <div className="flex items-center gap-2 text-emerald-400 text-xs font-semibold animate-pulse">
            <Mic className="w-4 h-4" />
            <span>Listening to audience… Speak now</span>
          </div>
        ) : turnPhase === 'thinking' ? (
          <div className="flex items-center gap-2 text-indigo-400 text-xs font-semibold">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Protagonist is deciding…</span>
          </div>
        ) : turnPhase === 'speaking' ? (
          <div className="flex items-center gap-2 text-amber-400 text-xs font-semibold animate-pulse">
            <Volume2 className="w-4 h-4" />
            <span>Protagonist is speaking…</span>
          </div>
        ) : (
          <div className="text-slate-400 text-xs font-medium">
            Story is playing on computer screen
          </div>
        )}
      </div>

      {/* Transcript Stream */}
      <div
        ref={transcriptScrollRef}
        className="flex-1 p-4 overflow-y-auto space-y-3 font-sans text-sm"
      >
        {transcript.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 text-xs py-12">
            <p>Stand by. When the story pauses for a decision, tap and speak to give your input.</p>
          </div>
        ) : (
          transcript.map((item) => {
            const isAudience = item.role === 'audience';
            const isProtagonist = item.role === 'protagonist';
            return (
              <div
                key={item.id}
                className={`flex flex-col ${isAudience ? 'items-end' : 'items-start'}`}
              >
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1 px-1">
                  {isAudience ? 'You (Audience)' : isProtagonist ? 'Protagonist' : 'Narrator'}
                </span>
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                    isAudience
                      ? 'bg-indigo-600 text-white rounded-br-none'
                      : isProtagonist
                        ? 'bg-slate-800 text-indigo-200 border border-slate-700 rounded-bl-none font-medium'
                        : 'bg-slate-900 text-slate-300 border border-slate-800'
                  }`}
                >
                  {item.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Mobile Push-To-Talk / Interaction Control */}
      <div className="p-4 bg-slate-900/80 border-t border-slate-800 space-y-3">
        <div className="flex flex-col items-center justify-center py-2">
          <button
            type="button"
            onPointerDown={startRecording}
            onPointerUp={stopRecording}
            onPointerLeave={stopRecording}
            disabled={turnPhase === 'thinking' || turnPhase === 'speaking'}
            className={`w-24 h-24 rounded-full flex flex-col items-center justify-center gap-1.5 shadow-2xl transition-all select-none touch-none ${
              isRecording
                ? 'bg-red-500 scale-105 shadow-red-500/50 ring-4 ring-red-400/30'
                : turnPhase === 'thinking' || turnPhase === 'speaking'
                  ? 'bg-slate-800 text-slate-600 opacity-60 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-500 text-white active:scale-95'
            }`}
          >
            <Mic className={`w-8 h-8 ${isRecording ? 'animate-bounce' : ''}`} />
            <span className="text-[10px] font-bold uppercase tracking-wider">
              {isRecording ? 'Release' : 'Hold Talk'}
            </span>
          </button>
          <span className="text-[11px] text-slate-400 mt-2 font-medium">
            {isRecording ? 'Listening… release when done' : 'Hold button to speak with protagonist'}
          </span>
        </div>

        {/* Text fallback input */}
        <form onSubmit={handleSendText} className="flex items-center gap-2 pt-2 border-t border-slate-800/80">
          <input
            type="text"
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Or type a message…"
            disabled={turnPhase === 'thinking' || turnPhase === 'speaking'}
            className="flex-1 bg-slate-800/80 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
          />
          <button
            type="submit"
            disabled={!textInput.trim() || turnPhase === 'thinking' || turnPhase === 'speaking'}
            className="p-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg text-white transition-colors"
          >
            <Send className="w-4 h-4" />
          </button>
        </form>
      </div>
    </div>
  );
}
