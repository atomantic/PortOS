import { useEffect, useRef, useState } from 'react';
import { AudioLines, Mic, MicOff, PhoneOff, ScanFace, Send, Square } from 'lucide-react';
import { getVoiceOutputLevel } from '../../services/voiceClient';
import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage';

const DISPLAY_KEY = 'portos.voice.callDisplay';
const control = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-port-border bg-port-bg px-3 py-2 text-sm font-semibold hover:border-port-accent disabled:opacity-50';
const STATUS = {
  idle: 'Standby',
  listening: 'Listening',
  handsfree: 'Mic open',
  capturing: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
};

function Portrait({ speaking }) {
  const mouth = useRef(null);
  useEffect(() => {
    if (!speaking || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const element = mouth.current;
    let frame;
    const draw = () => {
      const level = getVoiceOutputLevel();
      element.setAttribute('ry', (1.2 + level * 9).toFixed(2));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      element.setAttribute('ry', '1.2');
    };
  }, [speaking]);

  return (
    <svg aria-hidden="true" viewBox="0 0 240 208" className="h-full max-h-60 w-auto max-w-full text-port-accent">
      <circle cx="120" cy="102" r="88" fill="none" stroke="currentColor" strokeOpacity=".23" strokeDasharray="3 6" />
      <path d="M24 60V32h28m164 28V32h-28M24 145v28h28m164-28v28h-28" fill="none" stroke="currentColor" strokeOpacity=".62" strokeWidth="2" />
      <path d="M52 193c7-20 25-31 51-35h34c27 4 43 15 51 35Z" fill="currentColor" fillOpacity=".13" stroke="currentColor" strokeOpacity=".6" strokeWidth="2" />
      <path d="M72 96a48 48 0 0 1 96 0" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <rect x="67" y="92" width="15" height="30" rx="6" fill="currentColor" />
      <rect x="158" y="92" width="15" height="30" rx="6" fill="currentColor" />
      <rect x="84" y="67" width="72" height="85" rx="28" fill="var(--color-port-card)" stroke="currentColor" strokeWidth="2" />
      <path d="M103 100h6m22 0h6" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" />
      <ellipse ref={mouth} cx="120" cy="124" rx="12" ry="1.2" fill="currentColor" />
      <path d="M166 125v8l-12 7h-14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function TransmissionLog({ history, scrollRef }) {
  return (
    <section className="min-w-0 rounded-xl border border-port-border bg-port-bg px-4 py-3">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-port-text-muted">Transmission log</h2>
      <div ref={scrollRef} className="mt-2 max-h-52 overflow-y-auto">
        <div role="log" aria-label="Transmission log" className="space-y-2 break-words text-sm">
          {history.length === 0 && <p className="text-port-text-muted">Your conversation will appear here.</p>}
          {history.map((turn, i) => (
            <p key={i}><span className="mr-2 font-mono text-xs uppercase text-port-text-muted">{turn.role === 'user' ? 'You' : 'Agent'}</span>{turn.text}</p>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function VoiceCallConsole({
  stage, history, scrollRef, interimTranscript, capturing, handsFree, canChangeMicMode,
  draft, onDraft, onSend, onMic, onMode, onInterrupt, onEnd, voiceLabel,
}) {
  const [avatar, setAvatar] = useState(() => safeReadStorage(DISPLAY_KEY) !== 'audio');
  const caption = interimTranscript || history.at(-1)?.text;
  const openMic = handsFree || !canChangeMicMode;
  const micText = capturing ? (openMic ? 'Close mic' : 'Send voice') : (openMic ? 'Open mic' : 'Talk');
  const MicIcon = capturing ? MicOff : Mic;

  const toggleAvatar = () => {
    safeWriteStorage(DISPLAY_KEY, avatar ? 'audio' : 'avatar');
    setAvatar(!avatar);
  };

  return (
    <section data-voice-widget aria-label="PortOS call console"
      className="space-y-3 rounded-2xl border border-port-border bg-port-card p-3 text-port-text shadow-xl sm:p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-xs font-bold uppercase tracking-widest">PortOS<span className="ml-2 font-normal text-port-text-muted">Transceiver</span></p>
        <p role="status" className="flex items-center gap-2 rounded-full border border-port-border px-2.5 py-1 font-mono text-xs">
          <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${stage === 'idle' ? 'bg-port-text-muted' : 'bg-port-success'}`} />
          {STATUS[stage] || STATUS.idle}
        </p>
      </header>

      <div className="relative isolate grid min-h-52 grid-rows-[minmax(9rem,1fr)_auto] overflow-hidden rounded-xl border border-port-border bg-port-bg p-3 sm:min-h-64">
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-[repeating-linear-gradient(transparent_0px,transparent_3px,currentColor_4px)] text-port-accent opacity-[0.08]" />
        <div className="min-w-0 place-self-center">
          {avatar ? <Portrait speaking={stage === 'speaking'} /> : <AudioLines aria-hidden="true" size={64} className="text-port-accent" />}
        </div>
        <p aria-hidden="true" className="line-clamp-2 min-h-12 break-words rounded-md border-l-2 border-port-accent bg-port-card px-3 py-2 text-sm">
          {caption || 'Ready when you are.'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-port-text-muted">
        <span className="min-w-0 max-w-full break-words">Voice: {voiceLabel || 'Use saved settings'}</span>
        <button type="button" onClick={toggleAvatar} aria-pressed={avatar} className={`ml-auto ${control}`}>
          <ScanFace size={16} aria-hidden="true" /> Avatar
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <button type="button" onClick={onMic} aria-pressed={capturing}
          className={`${control} border-port-accent/50 text-port-accent`}>
          <MicIcon size={16} aria-hidden="true" /> {micText}
        </button>
        {canChangeMicMode && (
          <button type="button" className={control} onClick={onMode} aria-pressed={handsFree}>
            Hands-free
          </button>
        )}
        {stage === 'speaking' && (
          <button type="button" className={control} onClick={onInterrupt}>
            <Square size={14} aria-hidden="true" /> Interrupt
          </button>
        )}
        <button type="button" className={`${control} text-port-error sm:ml-auto`} onClick={onEnd} disabled={stage === 'idle'}>
          <PhoneOff size={16} aria-hidden="true" /> End
        </button>
      </div>
      <form className="flex min-w-0 gap-2" onSubmit={(event) => { event.preventDefault(); onSend(); }}>
        <input type="text" aria-label="Message to the voice assistant" value={draft}
          onChange={(event) => onDraft(event.target.value)} placeholder="Type a message…"
          className="min-w-0 flex-1 rounded-lg border border-port-border bg-port-bg px-3 text-sm focus:border-port-accent" />
        <button type="submit" disabled={!draft.trim()} className={control}><Send size={15} aria-hidden="true" /> Send</button>
      </form>
      <TransmissionLog history={history} scrollRef={scrollRef} />
    </section>
  );
}
