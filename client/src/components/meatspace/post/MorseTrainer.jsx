import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Radio, Headphones, Hand, CheckCircle, XCircle, Play, RefreshCw, Volume2, GitBranch, List as ListIcon, Ruler, Eraser } from 'lucide-react';

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

// Group entries by code length for the "Length" reference view.
const MORSE_BY_LENGTH = MORSE_ENTRIES.reduce((acc, [ch, code]) => {
  (acc[code.length] ||= []).push([ch, code]);
  return acc;
}, {});

// Binary tree: walk left for `-` (DAH), right for `.` (DIT). Each node's path
// from the root spells its morse code; missing paths are nulls (e.g. `----`).
const MORSE_TREE = (() => {
  const root = { char: '·', code: '', dah: null, dit: null };
  for (const [ch, code] of MORSE_ENTRIES) {
    let node = root;
    for (const sym of code) {
      const k = sym === '-' ? 'dah' : 'dit';
      if (!node[k]) node[k] = { char: '', code: node.code + sym, dah: null, dit: null };
      node = node[k];
    }
    node.char = ch;
  }
  return root;
})();

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

// `enabled` must default false-friendly so the global spacebar listener only
// attaches in Send mode — otherwise it competes with text input in Copy mode
// and suppresses the voice-widget push-to-talk hotkey via stopImmediatePropagation.
function useKeyingDecoder({ unitMs, hz, ensureCtx, enabled = true }) {
  const oscRef = useRef(null);
  const gainRef = useRef(null);
  const pressStartRef = useRef(0);
  const lastReleaseRef = useRef(0);
  const flushTimerRef = useRef(null);
  const wordTimerRef = useRef(null);
  const patternRef = useRef('');

  const [pattern, setPattern] = useState('');
  const [decoded, setDecoded] = useState('');
  const [pressing, setPressing] = useState(false);

  const startTone = useCallback(() => {
    const ctx = ensureCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = hz;
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(TONE_GAIN, now + RAMP_SEC);
    oscRef.current = osc;
    gainRef.current = gain;
  }, [ensureCtx, hz]);

  const stopTone = useCallback(() => {
    const osc = oscRef.current;
    const gain = gainRef.current;
    if (!osc || !gain) return;
    const ctx = ensureCtx();
    const now = ctx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + RAMP_SEC);
    osc.stop(now + 0.02);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    oscRef.current = null;
    gainRef.current = null;
  }, [ensureCtx]);

  const flushLetter = useCallback(() => {
    const buf = patternRef.current;
    if (!buf) return;
    const ch = MORSE_LOOKUP[buf] || '?';
    setDecoded((d) => d + ch);
    patternRef.current = '';
    setPattern('');
  }, []);

  const beginPress = useCallback(() => {
    if (pressing) return;
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    if (wordTimerRef.current) { clearTimeout(wordTimerRef.current); wordTimerRef.current = null; }
    setPressing(true);
    pressStartRef.current = performance.now();
    startTone();
  }, [pressing, startTone]);

  const endPress = useCallback(() => {
    if (!pressing) return;
    setPressing(false);
    stopTone();
    const now = performance.now();
    const duration = now - pressStartRef.current;
    const sym = duration < 2 * unitMs ? '.' : '-';
    patternRef.current += sym;
    setPattern(patternRef.current);
    lastReleaseRef.current = now;
    flushTimerRef.current = setTimeout(flushLetter, 3 * unitMs);
    wordTimerRef.current = setTimeout(() => setDecoded((d) => d.endsWith(' ') ? d : d + ' '), 7 * unitMs);
  }, [pressing, stopTone, unitMs, flushLetter]);

  const clear = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    if (wordTimerRef.current) clearTimeout(wordTimerRef.current);
    flushTimerRef.current = null;
    wordTimerRef.current = null;
    patternRef.current = '';
    lastReleaseRef.current = 0;
    setPattern('');
    setDecoded('');
  }, []);

  // Capture-phase listener with stopImmediatePropagation prevents other global
  // spacebar handlers (notably the voice widget's push-to-talk hotkey) from
  // firing while the user is keying morse. This only suppresses spacebar; the
  // voice widget's hotkey works normally everywhere else in the app.
  useEffect(() => {
    if (!enabled) return undefined;
    function consume(e) {
      if (e.code !== 'Space') return false;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return false;
      if (e.target && e.target.isContentEditable) return false;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      return true;
    }
    function onKeyDown(e) {
      if (!consume(e) || e.repeat) return;
      beginPress();
    }
    function onKeyUp(e) {
      if (!consume(e)) return;
      endPress();
    }
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (wordTimerRef.current) clearTimeout(wordTimerRef.current);
      stopTone();
    };
  }, [beginPress, endPress, stopTone, enabled]);

  return { pattern, decoded, pressing, beginPress, endPress, clear };
}

export default function MorseTrainer({ onBack }) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [mode, setMode] = useState(null);
  const ensureCtx = useAudioContext();
  const unitMs = 1.2 / prefs.wpm * 1000;
  const keying = useKeyingDecoder({ unitMs, hz: prefs.hz, ensureCtx, enabled: mode === 'send' });

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
    <div className="space-y-6">
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

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_24rem] gap-6">
        <div className="space-y-6 min-w-0 max-w-2xl">
          <SettingsPanel prefs={prefs} updatePrefs={updatePrefs} onResetProgress={resetProgress} />
          {!mode && <ModeGrid onPick={setMode} />}
          {mode === 'copy' && (
            <CopyDrill prefs={prefs} updatePrefs={updatePrefs} ensureCtx={ensureCtx} onExit={() => setMode(null)} />
          )}
          {mode === 'send' && (
            <SendDrill keying={keying} onExit={() => setMode(null)} />
          )}
        </div>
        <ReferenceWidget keying={keying} mode={mode} />
      </div>
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

const REFERENCE_VIEWS = [
  { id: 'tree', label: 'Tree', icon: GitBranch },
  { id: 'length', label: 'Length', icon: Ruler },
  { id: 'list', label: 'List', icon: ListIcon },
];

function ReferenceWidget({ keying, mode }) {
  const [view, setView] = useState('tree');
  // Only show the in-progress key path in Send mode — in Copy mode the right
  // widget is a passive cheat-sheet, not live feedback for the user.
  const currentPath = mode === 'send' ? keying.pattern : '';

  return (
    <div className="space-y-4 xl:sticky xl:top-4 xl:self-start">
      <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
        <div className="flex border-b border-port-border">
          {REFERENCE_VIEWS.map((v) => {
            const Icon = v.icon;
            const active = view === v.id;
            return (
              <button
                key={v.id}
                onClick={() => setView(v.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors ${
                  active ? 'bg-port-bg text-port-accent' : 'text-gray-400 hover:text-white'
                }`}
              >
                <Icon size={12} />
                {v.label}
              </button>
            );
          })}
        </div>
        <div className="p-4">
          {view === 'tree' && <TreeView currentPath={currentPath} />}
          {view === 'length' && <LengthView currentPath={currentPath} />}
          {view === 'list' && <ListView currentPath={currentPath} />}
        </div>
      </div>

      {mode === 'send' && <KeyPad keying={keying} />}
    </div>
  );
}

function TreeNode({ node, currentPath }) {
  if (!node) return <div className="flex-1" />;
  const matched = !!node.char && currentPath === node.code;
  const onPath = currentPath.length > 0 && currentPath.startsWith(node.code) && node.code !== currentPath;
  const hasChildren = node.dah || node.dit;
  const display = node.char || (node.code === '' ? '·' : '');

  return (
    <div className="flex flex-col items-center min-w-0 flex-1">
      <div
        className={`text-[11px] font-mono px-1.5 py-0.5 rounded transition-colors ${
          matched ? 'bg-port-accent text-white font-bold' :
          onPath ? 'text-port-accent' :
          display ? 'text-gray-300' : 'text-gray-700'
        }`}
        title={node.code || 'start'}
      >
        {display || '·'}
      </div>
      {hasChildren && (
        <div className={`flex gap-0.5 mt-0.5 w-full border-t ${onPath || matched ? 'border-port-accent/40' : 'border-port-border'}`}>
          <TreeNode node={node.dah} currentPath={currentPath} />
          <TreeNode node={node.dit} currentPath={currentPath} />
        </div>
      )}
    </div>
  );
}

function TreeView({ currentPath }) {
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500 mb-2">
        <span>← dah</span>
        <span>start</span>
        <span>dit →</span>
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="min-w-[36rem]">
          <TreeNode node={MORSE_TREE} currentPath={currentPath} />
        </div>
      </div>
      <p className="text-[10px] text-gray-500 mt-3">
        Tap or hold space to key. The path you're on lights up.
      </p>
    </div>
  );
}

function LengthView({ currentPath }) {
  const lengths = Object.keys(MORSE_BY_LENGTH).map(Number).sort((a, b) => a - b);
  return (
    <div className="space-y-3">
      {lengths.map((len) => (
        <div key={len}>
          <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">
            {len} symbol{len > 1 ? 's' : ''}
          </div>
          <div className="grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
            {MORSE_BY_LENGTH[len].map(([ch, code]) => {
              const matched = code === currentPath;
              return (
                <div key={ch} className="flex items-center gap-2">
                  <span className={`font-mono w-4 ${matched ? 'text-port-accent font-bold' : 'text-white'}`}>{ch}</span>
                  <span className={`font-mono text-xs ${matched ? 'text-port-accent' : 'text-gray-500'}`}>{code}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function ListView({ currentPath }) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-1.5 text-sm">
      {MORSE_ENTRIES.map(([ch, code]) => {
        const matched = code === currentPath;
        return (
          <div key={ch} className="flex items-center gap-2">
            <span className={`font-mono w-4 ${matched ? 'text-port-accent font-bold' : 'text-white'}`}>{ch}</span>
            <span className={`font-mono text-xs ${matched ? 'text-port-accent' : 'text-port-accent/60'}`}>{code}</span>
          </div>
        );
      })}
    </div>
  );
}

function KeyPad({ keying }) {
  return (
    <div className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-medium text-gray-400 uppercase tracking-wide">Practice Key</div>
        <button
          onClick={keying.clear}
          className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-port-error transition-colors"
        >
          <Eraser size={11} /> Clear
        </button>
      </div>
      <button
        onMouseDown={keying.beginPress}
        onMouseUp={keying.endPress}
        onMouseLeave={() => keying.pressing && keying.endPress()}
        onTouchStart={(e) => { e.preventDefault(); keying.beginPress(); }}
        onTouchEnd={(e) => { e.preventDefault(); keying.endPress(); }}
        className={`w-full select-none py-6 rounded-lg border-2 font-mono text-base transition-colors ${
          keying.pressing ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-port-border bg-port-bg text-gray-400 hover:border-port-accent'
        }`}
      >
        {keying.pressing ? '▮ KEYING' : 'TAP / HOLD SPACE'}
      </button>
      <p className="text-[10px] text-gray-500 text-center">
        Tap short for · · hold for —. Your decoded text appears in the drill.
      </p>
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

function CopyDrill({ prefs, updatePrefs, ensureCtx, onExit }) {
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
          <div className="space-y-3">
            {feedback.correct ? (
              <CheckCircle size={36} className="text-port-success mx-auto" />
            ) : (
              <XCircle size={36} className="text-port-error mx-auto" />
            )}
            <div className="text-3xl font-mono font-bold text-port-accent tracking-widest">
              {feedback.prompt}
            </div>
            <div className="font-mono text-port-accent/70 text-base tracking-widest">
              {feedback.prompt.split('').map((c) => MORSE_TABLE[c] || '').join('   ')}
            </div>
            {!feedback.correct && (
              <div className="text-gray-400 text-xs pt-1">
                You typed <span className="font-mono text-white">{feedback.guess || '—'}</span>
              </div>
            )}
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

function SendDrill({ keying, onExit }) {
  const [prompt, setPrompt] = useState(() => pickSendPrompt());
  const [feedback, setFeedback] = useState(null);

  // Drop any stale keying state from a prior session so "Your sending" starts empty.
  const { clear: clearKeying } = keying;
  useEffect(() => {
    clearKeying();
  }, [clearKeying]);

  function decodeNow() {
    const target = prompt.toUpperCase();
    const got = keying.decoded.replace(/\s+/g, ' ').trim().toUpperCase();
    setFeedback({ correct: got === target, decoded: got, target });
  }

  function nextPrompt() {
    keying.clear();
    setFeedback(null);
    setPrompt(pickSendPrompt());
  }

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-6 space-y-5">
      <div className="text-center">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-1">Send this</div>
        <div className="text-3xl font-mono font-bold text-white tracking-widest">{prompt}</div>
      </div>

      <p className="text-xs text-gray-500 text-center">
        Hold space (or tap the practice key on the right) to send dits and dahs. Use the reference tabs if you need a hint.
      </p>

      <div className="bg-port-bg border border-port-border rounded-lg p-3 min-h-[3rem] flex flex-col items-center justify-center">
        <div className="text-[10px] uppercase tracking-wide text-gray-500 mb-1">Your sending</div>
        {keying.decoded ? (
          <div className="font-mono text-white text-lg tracking-widest break-all">{keying.decoded}</div>
        ) : (
          <div className="text-[11px] text-gray-600 italic">waiting for your first key…</div>
        )}
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
            Check
          </button>
          <button onClick={keying.clear} className="px-4 py-2.5 bg-port-card border border-port-border hover:border-port-accent text-gray-300 rounded-lg transition-colors">
            Clear
          </button>
        </div>
      )}
    </div>
  );
}
