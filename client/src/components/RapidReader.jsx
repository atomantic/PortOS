import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Play, Pause, RotateCcw, Rewind, FastForward, X, Zap } from 'lucide-react';

// Optimal Recognition Point — the focal letter the eye lands on. Spritz-style:
// shorter words use a left-shifted ORP, longer words shift right. Returns the
// index into the trimmed word that should be highlighted.
const orpIndex = (word) => {
  const w = word || '';
  const len = w.length;
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
};

// Tokenize while preserving punctuation attached to words. Strips empty tokens.
// Each token may be one or two words depending on `chunkSize`. Short connector
// words (≤3 chars) merge into the next token when chunkSize=2 — feels natural
// at speed and keeps WPM honest.
const tokenize = (text, chunkSize) => {
  if (!text) return [];
  const raw = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (chunkSize === 1) return raw;
  const out = [];
  let i = 0;
  while (i < raw.length) {
    const a = raw[i];
    const b = raw[i + 1];
    if (b && (a.length <= 3 || b.length <= 3) && (a.length + b.length) <= 12) {
      out.push(`${a} ${b}`);
      i += 2;
    } else {
      out.push(a);
      i += 1;
    }
  }
  return out;
};

// Sentence-end detection: word ends with terminal punctuation. Used to add a
// brief extra pause so the reader can register the boundary.
const endsSentence = (word) => /[.!?…]"?$/.test(word || '');
const endsClause = (word) => /[,;:)]"?$/.test(word || '');

// Core reader display — drop into any container. Self-paced; emits onComplete
// when the last token is shown.
export default function RapidReader({
  text = '',
  wpm: initialWpm = 350,
  chunkSize: initialChunk = 1,
  focalColor = '#ef4444',
  autoPlay = false,
  compact = false,
  onClose,
  onComplete
}) {
  const [wpm, setWpm] = useState(initialWpm);
  const [chunkSize, setChunkSize] = useState(initialChunk);
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const timeoutRef = useRef(null);

  const tokens = useMemo(() => tokenize(text, chunkSize), [text, chunkSize]);
  const total = tokens.length;
  const current = tokens[idx] || '';

  // Keep idx in range when text/chunkSize changes
  useEffect(() => {
    if (idx >= tokens.length && tokens.length > 0) setIdx(tokens.length - 1);
  }, [tokens.length, idx]);

  // Per-token delay: base = 60000/wpm ms. Long chunks and sentence boundaries
  // get extra time; ultra-short tokens get a small bonus too.
  const delayFor = useCallback((token) => {
    const base = 60000 / Math.max(60, wpm);
    let mult = 1;
    if (endsSentence(token)) mult = 1.8;
    else if (endsClause(token)) mult = 1.3;
    if (token && token.length > 8) mult *= 1.15;
    return base * mult;
  }, [wpm]);

  useEffect(() => {
    if (!playing) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      return;
    }
    if (idx >= total) {
      setPlaying(false);
      onComplete?.();
      return;
    }
    timeoutRef.current = setTimeout(() => {
      setIdx((i) => i + 1);
    }, delayFor(current));
    return () => clearTimeout(timeoutRef.current);
  }, [playing, idx, total, current, delayFor, onComplete]);

  // Keyboard controls — only active when this component is mounted.
  // Registered in the capture phase so we run before bubble-phase window
  // listeners (notably VoiceWidget's hotkey, which also claims Space). When
  // we handle a key we call stopImmediatePropagation so the voice agent
  // doesn't toggle its mic on the same press.
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (e.key === ' ') setPlaying((p) => !p);
      else if (e.key === 'ArrowLeft') setIdx((i) => Math.max(0, i - 1));
      else if (e.key === 'ArrowRight') setIdx((i) => Math.min(total - 1, i + 1));
      else if (e.key === 'r' || e.key === 'R') { setIdx(0); setPlaying(true); }
      else if (e.key === '+' || e.key === '=') setWpm((w) => Math.min(1200, w + 25));
      else if (e.key === '-' || e.key === '_') setWpm((w) => Math.max(100, w - 25));
      else if (e.key === 'Escape' && onClose) onClose();
      else return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [total, onClose]);

  const restart = () => { setIdx(0); setPlaying(true); };
  const togglePlay = () => {
    if (idx >= total - 1) { restart(); return; }
    setPlaying((p) => !p);
  };
  const back = () => { setPlaying(false); setIdx((i) => Math.max(0, i - 5)); };
  const fwd = () => { setPlaying(false); setIdx((i) => Math.min(total - 1, i + 5)); };

  const progress = total ? ((idx + 1) / total) * 100 : 0;
  const elapsedSec = Math.round(((idx + 1) * 60) / Math.max(60, wpm));
  const totalSec = Math.round((total * 60) / Math.max(60, wpm));

  if (!total) {
    return (
      <div className={`bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500 ${compact ? '' : 'min-h-64'}`}>
        Paste or pass some text to start reading.
      </div>
    );
  }

  return (
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden">
      {/* Reader display */}
      <div className={`relative bg-port-bg flex items-center justify-center ${compact ? 'py-10' : 'py-16 sm:py-24'}`}>
        {/* Center alignment guide — vertical line at the focal point */}
        <div
          className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-px bg-port-border/50 pointer-events-none"
          aria-hidden="true"
        />
        <div
          className="relative font-mono text-3xl sm:text-5xl tracking-wide text-white whitespace-pre"
          style={{ minWidth: '12ch' }}
        >
          {/* Position chunk so its focal letter sits on the center guide */}
          <FocalSlot chunk={current} focalColor={focalColor} />
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1 bg-port-border/40">
        <div
          className="h-full bg-port-accent transition-[width] duration-150"
          style={{ width: `${progress}%` }}
        />
      </div>

      {/* Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 bg-port-card">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={back}
            className="min-h-10 min-w-10 flex items-center justify-center rounded-lg border border-port-border text-gray-400 hover:text-white hover:bg-port-bg/60"
            title="Back 5 (←)"
            aria-label="Back 5 words"
          >
            <Rewind size={16} />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            className="min-h-10 min-w-10 flex items-center justify-center rounded-lg bg-port-accent/15 border border-port-accent/40 text-port-accent hover:bg-port-accent/25"
            title={playing ? 'Pause (space)' : 'Play (space)'}
            aria-label={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button
            type="button"
            onClick={fwd}
            className="min-h-10 min-w-10 flex items-center justify-center rounded-lg border border-port-border text-gray-400 hover:text-white hover:bg-port-bg/60"
            title="Forward 5 (→)"
            aria-label="Forward 5 words"
          >
            <FastForward size={16} />
          </button>
          <button
            type="button"
            onClick={restart}
            className="min-h-10 min-w-10 flex items-center justify-center rounded-lg border border-port-border text-gray-400 hover:text-white hover:bg-port-bg/60"
            title="Restart (R)"
            aria-label="Restart"
          >
            <RotateCcw size={16} />
          </button>
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="min-h-10 min-w-10 flex items-center justify-center rounded-lg border border-port-border text-gray-400 hover:text-white hover:bg-port-bg/60 ml-1"
              title="Close (Esc)"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400">
          <label className="flex items-center gap-2">
            <span className="text-gray-500">WPM</span>
            <input
              type="range"
              min={100}
              max={1000}
              step={25}
              value={wpm}
              onChange={(e) => setWpm(Number(e.target.value))}
              className="w-28 sm:w-32 accent-port-accent"
            />
            <span className="font-mono text-gray-300 w-10 text-right">{wpm}</span>
          </label>
          <div className="flex items-center gap-1 border border-port-border rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => setChunkSize(1)}
              className={`px-2 py-1 text-xs ${chunkSize === 1 ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              aria-pressed={chunkSize === 1}
            >
              1w
            </button>
            <button
              type="button"
              onClick={() => setChunkSize(2)}
              className={`px-2 py-1 text-xs ${chunkSize === 2 ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              aria-pressed={chunkSize === 2}
            >
              2w
            </button>
          </div>
          <span className="font-mono text-gray-500">
            {idx + 1}/{total} · {elapsedSec}s/{totalSec}s
          </span>
        </div>
      </div>
    </div>
  );
}

// Layout helper that anchors the focal letter on the vertical center guide.
// Splits the chunk so the focal char's left edge sits at the container midpoint.
function FocalSlot({ chunk, focalColor }) {
  const parts = chunk.split(' ');
  const target = parts.length === 2
    ? (parts[0].length >= parts[1].length ? 0 : 1)
    : 0;
  const word = parts[target] || '';
  const idx = orpIndex(word);
  const left = word.slice(0, idx);
  const focal = word.charAt(idx);
  const right = word.slice(idx + 1);

  // Build the left/right halves around the focal char.
  const leftHalf = parts.length === 2 && target === 1
    ? `${parts[0]} ${left}`
    : left;
  const rightHalf = parts.length === 2 && target === 0
    ? `${right} ${parts[1]}`
    : right;

  return (
    <div className="flex items-baseline justify-center">
      <span className="text-right" style={{ flex: '1 1 0', whiteSpace: 'pre' }}>
        {leftHalf}
      </span>
      <span style={{ color: focalColor }}>{focal}</span>
      <span className="text-left" style={{ flex: '1 1 0', whiteSpace: 'pre' }}>
        {rightHalf}
      </span>
    </div>
  );
}

// Modal wrapper — full-screen overlay so any page can pop the reader without
// leaving its context. Closes on Esc or backdrop click.
export function RapidReaderModal({ open, text, title, onClose, ...readerProps }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title || 'Rapid Reader'}
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="w-full max-w-3xl bg-port-card border border-port-border rounded-xl shadow-2xl">
        <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-port-border">
          <div className="flex items-center gap-2 text-sm text-gray-300 truncate">
            <Zap size={14} className="text-port-accent shrink-0" />
            <span className="truncate">{title || 'Rapid Reader'}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 min-w-10 flex items-center justify-center text-gray-400 hover:text-white"
            aria-label="Close rapid reader"
          >
            <X size={18} />
          </button>
        </div>
        <RapidReader text={text} onClose={onClose} autoPlay {...readerProps} />
      </div>
    </div>
  );
}

// One-line trigger button — drop next to any text-bearing surface to launch
// the modal. Keeps the open/close state local so callers don't have to.
export function RapidReaderTrigger({
  getText,
  text,
  title,
  label = 'Rapid Read',
  className = '',
  iconOnly = false,
  ...readerProps
}) {
  const [open, setOpen] = useState(false);
  const [resolvedText, setResolvedText] = useState('');

  const launch = () => {
    const t = typeof getText === 'function' ? getText() : (text || '');
    setResolvedText(t || '');
    setOpen(true);
  };

  return (
    <>
      <button
        type="button"
        onClick={launch}
        className={`inline-flex items-center gap-1.5 min-h-10 px-3 py-1.5 rounded-lg border border-port-border text-sm text-gray-300 hover:text-white hover:border-port-accent/50 hover:bg-port-bg/40 transition-colors ${className}`}
        title={label}
        aria-label={label}
      >
        <Zap size={14} className="text-port-accent" />
        {!iconOnly && <span>{label}</span>}
      </button>
      <RapidReaderModal
        open={open}
        text={resolvedText}
        title={title}
        onClose={() => setOpen(false)}
        {...readerProps}
      />
    </>
  );
}
