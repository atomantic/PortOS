import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Radio, Headphones, Hand, BookOpen, CheckCircle, XCircle, Play, RefreshCw, Volume2 } from 'lucide-react';

const MORSE_TABLE = {
  A: '.-',     B: '-...',   C: '-.-.',   D: '-..',    E: '.',      F: '..-.',
  G: '--.',    H: '....',   I: '..',     J: '.---',   K: '-.-',    L: '.-..',
  M: '--',     N: '-.',     O: '---',    P: '.--.',   Q: '--.-',   R: '.-.',
  S: '...',    T: '-',      U: '..-',    V: '...-',   W: '.--',    X: '-..-',
  Y: '-.--',   Z: '--..',
  0: '-----',  1: '.----',  2: '..---',  3: '...--',  4: '....-',
  5: '.....',  6: '-....',  7: '--...',  8: '---..',  9: '----.',
  '.': '.-.-.-', ',': '--..--', '?': '..--..', '/': '-..-.', '=': '-...-',
};

const MORSE_LOOKUP = Object.fromEntries(Object.entries(MORSE_TABLE).map(([k, v]) => [v, k]));
const MORSE_ENTRIES = Object.entries(MORSE_TABLE);

const KOCH_ORDER = ['K', 'M', 'U', 'R', 'E', 'S', 'N', 'A', 'P', 'T', 'L', 'W', 'I', '.', 'J', 'Z', '=', 'F', 'O', 'Y', ',', 'V', 'G', '5', '/', 'Q', '9', '2', 'H', '3', '8', 'B', '?', '4', '7', 'C', '1', 'D', '6', '0', 'X'];

const PREFS_KEY = 'portos-post-morse-prefs';
const DEFAULT_PREFS = { wpm: 18, effectiveWpm: 18, hz: 700, kochLevel: 2, bestAccuracy: 0 };

// Tone envelope ramp — fast enough to avoid clicks, slow enough to feel like a key
const RAMP_SEC = 0.005;
const TONE_GAIN = 0.25;

const MODES = [
  {
    id: 'copy',
    label: 'Copy',
    icon: Headphones,
    color: 'text-cyan-400',
    bgColor: 'bg-cyan-500/20',
    description: 'Listen to Morse, type what you hear',
    example: 'Koch progression: K, M → add letters as you hit 90%',
  },
  {
    id: 'send',
    label: 'Send',
    icon: Hand,
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/20',
    description: 'Hold spacebar (or tap) to key dits & dahs',
    example: 'Tap short for ·, hold long for —',
  },
];

function loadPrefs() {
  const raw = typeof window !== 'undefined' ? window.localStorage.getItem(PREFS_KEY) : null;
  if (!raw) return { ...DEFAULT_PREFS };
  const parsed = JSON.parse(raw);
  return { ...DEFAULT_PREFS, ...parsed };
}

function savePrefs(prefs) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

function scheduleTone(gain, startSec, durationSec) {
  gain.gain.setValueAtTime(0, startSec);
  gain.gain.linearRampToValueAtTime(TONE_GAIN, startSec + RAMP_SEC);
  gain.gain.setValueAtTime(TONE_GAIN, startSec + durationSec - RAMP_SEC);
  gain.gain.linearRampToValueAtTime(0, startSec + durationSec);
}

function playMorse(ctx, text, { wpm, effectiveWpm, hz }) {
  const unit = 1.2 / wpm;
  const charSpaceUnits = 3 * (wpm / Math.max(1, effectiveWpm));
  const wordSpaceUnits = 7 * (wpm / Math.max(1, effectiveWpm));

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = hz;
  gain.gain.value = 0;
  osc.connect(gain).connect(ctx.destination);

  let t = ctx.currentTime + 0.05;
  const chars = text.toUpperCase().split('');
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ') {
      t += wordSpaceUnits * unit;
      continue;
    }
    const pattern = MORSE_TABLE[ch];
    if (!pattern) continue;
    for (let j = 0; j < pattern.length; j++) {
      const sym = pattern[j];
      const dur = (sym === '.' ? 1 : 3) * unit;
      scheduleTone(gain, t, dur);
      t += dur;
      if (j < pattern.length - 1) t += unit;
    }
    if (i < chars.length - 1 && chars[i + 1] !== ' ') {
      t += charSpaceUnits * unit;
    }
  }

  const endTime = t + 0.05;
  osc.start();
  osc.stop(endTime);

  return new Promise((resolve) => {
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
      resolve();
    };
  });
}

function pickKochPrompt(level) {
  const pool = KOCH_ORDER.slice(0, Math.max(2, Math.min(level, KOCH_ORDER.length)));
  const groupLen = level >= 5 ? 5 : 1;
  let out = '';
  for (let i = 0; i < groupLen; i++) {
    out += pool[Math.floor(Math.random() * pool.length)];
  }
  return out;
}

const SEND_PROMPTS = ['SOS', 'CQ', 'HELLO', 'PORTOS', 'TEST', 'PARIS', 'DE K1AB', 'TNX 73'];

function pickSendPrompt() {
  return SEND_PROMPTS[Math.floor(Math.random() * SEND_PROMPTS.length)];
}

function useAudioContext() {
  const ctxRef = useRef(null);
  const ensureCtx = useCallback(() => {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    if (ctxRef.current.state === 'suspended') ctxRef.current.resume();
    return ctxRef.current;
  }, []);
  useEffect(() => () => {
    if (ctxRef.current) ctxRef.current.close();
    ctxRef.current = null;
  }, []);
  return ensureCtx;
}

export default function MorseTrainer({ onBack }) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [mode, setMode] = useState(null);
  const [showRef, setShowRef] = useState(false);

  function updatePrefs(patch) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      if (next.effectiveWpm > next.wpm) next.effectiveWpm = next.wpm;
      savePrefs(next);
      return next;
    });
  }

  function resetProgress() {
    updatePrefs({ kochLevel: 2, bestAccuracy: 0 });
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
            aria-label="Back"
          >
            <ArrowLeft size={16} />
          </button>
          <Radio size={24} className="text-port-accent" />
          <div>
            <h2 className="text-xl font-bold text-white">Morse Trainer</h2>
            <p className="text-sm text-gray-400">Listen, type, and key your way through CW</p>
          </div>
        </div>
        <button
          onClick={() => setShowRef((v) => !v)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-400 hover:text-white bg-port-card border border-port-border rounded-lg transition-colors"
        >
          <BookOpen size={14} />
          Reference
        </button>
      </div>

      <SettingsPanel prefs={prefs} updatePrefs={updatePrefs} onResetProgress={resetProgress} />

      {showRef && <ReferenceCard />}

      {!mode && <ModeGrid onPick={setMode} />}
      {mode === 'copy' && <CopyDrill prefs={prefs} updatePrefs={updatePrefs} onExit={() => setMode(null)} />}
      {mode === 'send' && <SendDrill prefs={prefs} onExit={() => setMode(null)} />}
    </div>
  );
}

function SettingsPanel({ prefs, updatePrefs, onResetProgress }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
      <SliderRow
        label="WPM"
        value={prefs.wpm}
        min={5}
        max={35}
        onChange={(v) => updatePrefs({ wpm: v })}
        suffix="wpm"
      />
      <SliderRow
        label="Farnsworth"
        value={prefs.effectiveWpm}
        min={5}
        max={prefs.wpm}
        onChange={(v) => updatePrefs({ effectiveWpm: v })}
        suffix="wpm"
        hint="Effective speed (≤ WPM)"
      />
      <SliderRow
        label="Tone"
        value={prefs.hz}
        min={400}
        max={1000}
        step={10}
        onChange={(v) => updatePrefs({ hz: v })}
        suffix="Hz"
      />
      <div className="sm:col-span-3 flex items-center justify-between text-xs text-gray-500 border-t border-port-border pt-3">
        <span>
          Koch level: <span className="text-white font-mono">{prefs.kochLevel}</span> /{' '}
          <span className="text-gray-400">{KOCH_ORDER.length}</span> ·{' '}
          Best round: <span className="text-white font-mono">{prefs.bestAccuracy}%</span>
        </span>
        <button
          onClick={onResetProgress}
          className="flex items-center gap-1 text-gray-400 hover:text-port-error transition-colors"
        >
          <RefreshCw size={12} /> Reset progress
        </button>
      </div>
    </div>
  );
}

function SliderRow({ label, value, min, max, step = 1, onChange, suffix = '', hint }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-gray-400 uppercase tracking-wide">{label}</label>
        <span className="text-sm text-white font-mono">{value}{suffix && ` ${suffix}`}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-port-accent"
      />
      {hint && <p className="text-[10px] text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}

function ReferenceCard() {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4">
      <h3 className="text-sm font-medium text-gray-400 mb-3">Reference</h3>
      <div className="grid grid-cols-4 sm:grid-cols-6 gap-x-3 gap-y-1.5 text-sm">
        {MORSE_ENTRIES.map(([ch, code]) => (
          <div key={ch} className="flex items-center gap-2">
            <span className="text-white font-mono w-4">{ch}</span>
            <span className="text-port-accent font-mono">{code}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModeGrid({ onPick }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {MODES.map((m) => {
        const Icon = m.icon;
        return (
          <button
            key={m.id}
            onClick={() => onPick(m.id)}
            className={`text-left bg-port-card border border-port-border hover:border-port-accent rounded-lg p-4 transition-colors`}
          >
            <div className={`inline-flex items-center justify-center w-9 h-9 rounded-lg ${m.bgColor} mb-3`}>
              <Icon size={18} className={m.color} />
            </div>
            <div className="text-white font-medium">{m.label}</div>
            <div className="text-xs text-gray-400 mt-1">{m.description}</div>
            <div className="text-[11px] text-gray-500 mt-2 font-mono">{m.example}</div>
          </button>
        );
      })}
    </div>
  );
}

const ROUND_SIZE = 10;

function CopyDrill({ prefs, updatePrefs, onExit }) {
  const ensureCtx = useAudioContext();
  const [prompt, setPrompt] = useState('');
  const [input, setInput] = useState('');
  const [results, setResults] = useState([]);
  const [feedback, setFeedback] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [done, setDone] = useState(false);
  const inputRef = useRef(null);

  async function startRound() {
    setResults([]);
    setFeedback(null);
    setDone(false);
    await playPrompt(true);
  }

  async function playPrompt(isNew) {
    const ctx = ensureCtx();
    const text = isNew ? pickKochPrompt(prefs.kochLevel) : prompt;
    if (isNew) {
      setPrompt(text);
      setInput('');
      setFeedback(null);
    }
    setPlaying(true);
    await playMorse(ctx, text, prefs);
    setPlaying(false);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function submit() {
    if (!prompt) return;
    const guess = input.trim().toUpperCase();
    const correct = guess === prompt;
    const next = [...results, { prompt, guess, correct }];
    setResults(next);
    setFeedback({ correct, prompt, guess });
    if (next.length >= ROUND_SIZE) {
      finishRound(next);
    }
  }

  function nextQuestion() {
    setFeedback(null);
    playPrompt(true);
  }

  function finishRound(rs) {
    const correctCount = rs.filter((r) => r.correct).length;
    const accuracy = Math.round((correctCount / rs.length) * 100);
    const patch = { bestAccuracy: Math.max(prefs.bestAccuracy, accuracy) };
    if (accuracy >= 90 && prefs.kochLevel < KOCH_ORDER.length) {
      patch.kochLevel = prefs.kochLevel + 1;
    }
    updatePrefs(patch);
    setDone(true);
  }

  function onKey(e) {
    if (e.key === 'Enter') {
      if (feedback) nextQuestion();
      else if (input) submit();
    }
  }

  if (done) {
    const correctCount = results.filter((r) => r.correct).length;
    const accuracy = Math.round((correctCount / results.length) * 100);
    const accColor = accuracy >= 90 ? 'text-port-success' : accuracy >= 70 ? 'text-port-warning' : 'text-port-error';
    const unlocked = accuracy >= 90;
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-6 space-y-4">
        <div className="text-center">
          <div className={`text-5xl font-mono font-bold ${accColor}`}>{accuracy}%</div>
          <div className="text-gray-400 text-sm mt-1">{correctCount} / {results.length} correct</div>
          {unlocked && prefs.kochLevel <= KOCH_ORDER.length && (
            <div className="text-port-success text-sm mt-3">
              ✓ Next letter unlocked: <span className="font-mono">{KOCH_ORDER[prefs.kochLevel - 1]}</span>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
          {results.map((r, i) => (
            <div
              key={i}
              className={`text-xs font-mono px-2 py-1.5 rounded border ${r.correct ? 'border-port-success/40 text-port-success' : 'border-port-error/40 text-port-error'}`}
            >
              {r.prompt} → {r.guess || '—'}
            </div>
          ))}
        </div>
        <div className="flex gap-3">
          <button onClick={startRound} className="flex-1 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors">
            New Round
          </button>
          <button onClick={onExit} className="flex-1 px-4 py-2.5 bg-port-card border border-port-border hover:border-port-accent text-white font-medium rounded-lg transition-colors">
            Pick Mode
          </button>
        </div>
      </div>
    );
  }

  if (!prompt) {
    return (
      <div className="bg-port-card border border-port-border rounded-lg p-6 space-y-4 text-center">
        <Headphones size={32} className="text-cyan-400 mx-auto" />
        <p className="text-gray-300">
          Koch level <span className="font-mono text-white">{prefs.kochLevel}</span> — pool: {' '}
          <span className="font-mono text-port-accent">{KOCH_ORDER.slice(0, prefs.kochLevel).join(' ')}</span>
        </p>
        <p className="text-xs text-gray-500">Listen to a 10-question round. Hit 90% to unlock the next letter.</p>
        <button
          onClick={startRound}
          className="px-6 py-3 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors inline-flex items-center gap-2"
        >
          <Play size={16} /> Start Round
        </button>
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-6 space-y-4">
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>Question {results.length + 1} / {ROUND_SIZE}</span>
        <button
          onClick={() => playPrompt(false)}
          disabled={playing}
          className="flex items-center gap-1 text-gray-400 hover:text-port-accent disabled:opacity-50 transition-colors"
        >
          <Volume2 size={14} /> Replay
        </button>
      </div>
      <div className="text-center py-6">
        {playing ? (
          <div className="text-cyan-400 text-sm animate-pulse">▮ ▮ ▮ playing...</div>
        ) : feedback ? (
          <div className="space-y-2">
            {feedback.correct ? (
              <CheckCircle size={36} className="text-port-success mx-auto" />
            ) : (
              <XCircle size={36} className="text-port-error mx-auto" />
            )}
            <div className="text-gray-400 text-xs">
              You typed <span className="font-mono text-white">{feedback.guess || '—'}</span> ·{' '}
              answer was <span className="font-mono text-port-accent">{feedback.prompt}</span>
            </div>
          </div>
        ) : (
          <div className="text-gray-500 text-sm">Type what you heard, then Enter</div>
        )}
      </div>
      {!feedback && (
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase().replace(/\s+/g, ''))}
          onKeyDown={onKey}
          autoFocus
          className="w-full px-4 py-3 bg-port-bg border border-port-border focus:border-port-accent rounded-lg text-white text-center font-mono text-lg uppercase tracking-widest outline-none"
          placeholder="????"
        />
      )}
      {feedback && (
        <button
          onClick={nextQuestion}
          autoFocus
          className="w-full px-6 py-3 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors"
        >
          {results.length >= ROUND_SIZE ? 'See Results' : 'Next'}
        </button>
      )}
    </div>
  );
}

// Each event holds the silence AFTER its symbol (gap to the next press). The
// final entry's gap is unknown until the user finishes — set to Infinity by
// the caller before decoding so the last letter gets flushed.
function decodeKeying(events, unitMs) {
  let buf = '';
  let out = '';
  const flush = () => {
    if (!buf) return;
    out += MORSE_LOOKUP[buf] || '?';
    buf = '';
  };
  for (const ev of events) {
    buf += ev.sym;
    if (ev.gapAfter >= 7 * unitMs) {
      flush();
      out += ' ';
    } else if (ev.gapAfter >= 3 * unitMs) {
      flush();
    }
  }
  flush();
  return out.trim();
}

function SendDrill({ prefs, onExit }) {
  const ensureCtx = useAudioContext();
  const oscRef = useRef(null);
  const gainRef = useRef(null);
  const pressStartRef = useRef(0);
  const lastReleaseRef = useRef(0);
  const eventsRef = useRef([]);
  const [pressing, setPressing] = useState(false);
  const [prompt, setPrompt] = useState(() => pickSendPrompt());
  const [decoded, setDecoded] = useState('');
  const [feedback, setFeedback] = useState(null);

  const unitMs = 1.2 / prefs.wpm * 1000;

  function startTone() {
    const ctx = ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = prefs.hz;
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(TONE_GAIN, now + RAMP_SEC);
    oscRef.current = osc;
    gainRef.current = gain;
  }

  function stopTone() {
    const osc = oscRef.current;
    const gain = gainRef.current;
    if (!osc || !gain) return;
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + RAMP_SEC);
    osc.stop(now + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    oscRef.current = null;
    gainRef.current = null;
  }

  const beginPress = useCallback(() => {
    if (pressing) return;
    setPressing(true);
    pressStartRef.current = performance.now();
    startTone();
  }, [pressing]);

  const endPress = useCallback(() => {
    if (!pressing) return;
    setPressing(false);
    stopTone();
    const now = performance.now();
    const duration = now - pressStartRef.current;
    const gapBefore = lastReleaseRef.current ? pressStartRef.current - lastReleaseRef.current : 0;
    const sym = duration < 2 * unitMs ? '.' : '-';
    const events = eventsRef.current;
    // Each event records the gap AFTER its symbol, but that gap isn't known
    // until the next press lands — so back-fill the previous event here.
    if (events.length > 0) events[events.length - 1].gapAfter = gapBefore;
    events.push({ sym, gapAfter: 0 });
    lastReleaseRef.current = now;
  }, [pressing, unitMs]);

  function decodeNow() {
    const events = eventsRef.current;
    if (events.length === 0) return;
    events[events.length - 1].gapAfter = Infinity;
    const text = decodeKeying(events, unitMs);
    setDecoded(text);
    const target = prompt.toUpperCase();
    setFeedback({ correct: text === target, decoded: text, target });
  }

  function clearKeying() {
    eventsRef.current = [];
    lastReleaseRef.current = 0;
    setDecoded('');
    setFeedback(null);
  }

  function nextPrompt() {
    clearKeying();
    setPrompt(pickSendPrompt());
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.code !== 'Space' || e.repeat) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      e.preventDefault();
      beginPress();
    }
    function onKeyUp(e) {
      if (e.code !== 'Space') return;
      e.preventDefault();
      endPress();
    }
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      stopTone();
    };
  }, [beginPress, endPress]);

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-6 space-y-5">
      <div className="text-center">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Send this</div>
        <div className="text-3xl font-mono font-bold text-white tracking-widest">{prompt}</div>
        <div className="text-[11px] text-gray-500 mt-2 font-mono">
          {prompt.split('').map((c) => MORSE_TABLE[c] || '').join(' ')}
        </div>
      </div>

      <button
        onMouseDown={beginPress}
        onMouseUp={endPress}
        onMouseLeave={() => pressing && endPress()}
        onTouchStart={(e) => { e.preventDefault(); beginPress(); }}
        onTouchEnd={(e) => { e.preventDefault(); endPress(); }}
        className={`w-full select-none py-12 rounded-lg border-2 font-mono text-lg transition-colors ${
          pressing ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-port-border bg-port-bg text-gray-400 hover:border-port-accent'
        }`}
      >
        {pressing ? '▮ KEYING' : 'HOLD SPACE OR TAP'}
      </button>

      <div className="bg-port-bg border border-port-border rounded-lg p-3 min-h-[3rem] text-center">
        <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Decoded</div>
        <div className="font-mono text-white text-lg tracking-widest">{decoded || '—'}</div>
      </div>

      {feedback ? (
        <div className="space-y-3">
          <div className="text-center">
            {feedback.correct ? (
              <CheckCircle size={36} className="text-port-success mx-auto" />
            ) : (
              <XCircle size={36} className="text-port-error mx-auto" />
            )}
            <div className="text-xs text-gray-400 mt-2">
              Decoded <span className="font-mono text-white">{feedback.decoded || '—'}</span>{' '}
              vs target <span className="font-mono text-port-accent">{feedback.target}</span>
            </div>
          </div>
          <div className="flex gap-3">
            <button onClick={nextPrompt} className="flex-1 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors">
              Next Prompt
            </button>
            <button onClick={onExit} className="flex-1 px-4 py-2.5 bg-port-card border border-port-border hover:border-port-accent text-white font-medium rounded-lg transition-colors">
              Pick Mode
            </button>
          </div>
        </div>
      ) : (
        <div className="flex gap-3">
          <button onClick={decodeNow} className="flex-1 px-4 py-2.5 bg-port-accent hover:bg-port-accent/80 text-white font-medium rounded-lg transition-colors">
            Decode &amp; Check
          </button>
          <button onClick={clearKeying} className="px-4 py-2.5 bg-port-card border border-port-border hover:border-port-accent text-gray-300 rounded-lg transition-colors">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
