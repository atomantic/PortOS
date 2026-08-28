import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Bookmark, Play, Pause, RotateCcw, Rewind, FastForward, X, Zap } from 'lucide-react';
import Modal from './ui/Modal';
import useKeyCapture from '../hooks/useKeyCapture';
import { noPointerFocusSurfaceProps } from '../lib/a11yKeyboard';
import { rapidReaderWords } from '../lib/rapidReaderPosition';
import { formatCountdown } from '../utils/formatters';

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

// Build the display chunk from the canonical word position. This keeps cursor
// starts and bookmarks exact even when they land where a prior 2-word chunk
// would have begun one word earlier.
const chunkAt = (words, wordIndex, chunkSize) => {
  const a = words[wordIndex]?.text || '';
  const b = words[wordIndex + 1]?.text;
  if (chunkSize === 2 && b && (a.length <= 3 || b.length <= 3) && (a.length + b.length) <= 12) {
    return { value: `${a} ${b}`, wordCount: 2 };
  }
  return { value: a, wordCount: 1 };
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
  inDialog = false,
  initialWordIndex = 0,
  onClose,
  onComplete,
  onPositionChange,
  onBookmark,
  onWpmChange,
  onChunkSizeChange,
}) {
  const [wpm, setWpm] = useState(initialWpm);
  const [chunkSize, setChunkSize] = useState(initialChunk);
  const [wordIndex, setWordIndex] = useState(initialWordIndex);
  const [playing, setPlaying] = useState(autoPlay);
  const timeoutRef = useRef(null);

  const words = useMemo(() => rapidReaderWords(text), [text]);
  const totalWords = words.length;
  const current = useMemo(() => chunkAt(words, wordIndex, chunkSize), [words, wordIndex, chunkSize]);

  // Position is a canonical word offset, so changing chunk size never jumps to
  // a different place in the source text.
  useEffect(() => {
    setWordIndex(Math.max(0, Math.min(initialWordIndex, Math.max(0, totalWords - 1))));
  }, [text, initialWordIndex, totalWords]);

  useEffect(() => {
    onPositionChange?.({ wordIndex, wordCount: totalWords, wpm, chunkSize, playing });
  }, [wordIndex, totalWords, wpm, chunkSize, playing, onPositionChange]);

  // Per-token delay: base = 60000/wpm ms. Long chunks and sentence boundaries
  // get extra time; ultra-short tokens get a small bonus too.
  const delayFor = useCallback((token) => {
    const base = 60000 / Math.max(60, wpm);
    let mult = 1;
    if (endsSentence(token?.value)) mult = 1.8;
    else if (endsClause(token?.value)) mult = 1.3;
    if (token?.value.length > 8) mult *= 1.15;
    return base * token.wordCount * mult;
  }, [wpm]);

  useEffect(() => {
    if (!playing) {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      return;
    }
    timeoutRef.current = setTimeout(() => {
      const nextWordIndex = wordIndex + current.wordCount;
      if (nextWordIndex < totalWords) setWordIndex(nextWordIndex);
      else {
        setPlaying(false);
        onComplete?.();
      }
    }, delayFor(current));
    return () => clearTimeout(timeoutRef.current);
  }, [playing, wordIndex, totalWords, current, delayFor, onComplete]);

  // Keyboard controls — only active while this component is mounted. Claimed in
  // the capture phase so a handled key never reaches a bubble-phase window
  // listener (notably VoiceWidget's hotkey, which also binds Space); keys we
  // do not handle pass through untouched.
  useKeyCapture({
    enabledInDialog: inDialog,
    onKeyDown: (e) => {
      if (e.key === ' ') {
        if (wordIndex >= totalWords - 1) { setWordIndex(0); setPlaying(true); }
        else setPlaying((p) => !p);
      }
      else if (e.key === 'ArrowLeft') setWordIndex((value) => Math.max(0, value - 1));
      else if (e.key === 'ArrowRight') setWordIndex((value) => Math.min(totalWords - 1, value + 1));
      else if (e.key === 'r' || e.key === 'R') { setWordIndex(0); setPlaying(true); }
      else if ((e.key === 'b' || e.key === 'B') && onBookmark) onBookmark(wordIndex);
      else if (e.key === '+' || e.key === '=') setWpm((value) => {
        const next = Math.min(1000, value + 25);
        onWpmChange?.(next);
        return next;
      });
      else if (e.key === '-' || e.key === '_') setWpm((value) => {
        const next = Math.max(100, value - 25);
        onWpmChange?.(next);
        return next;
      });
      else if (e.key === 'Escape' && onClose) onClose();
      else return false;
      return true;
    },
  });

  const restart = () => { setWordIndex(0); setPlaying(true); };
  const togglePlay = () => {
    if (wordIndex >= totalWords - 1) { restart(); return; }
    setPlaying((p) => !p);
  };
  const back = () => { setPlaying(false); setWordIndex((value) => Math.max(0, value - 5)); };
  const fwd = () => { setPlaying(false); setWordIndex((value) => Math.min(totalWords - 1, value + 5)); };
  const changeWpm = (next) => { setWpm(next); onWpmChange?.(next); };
  const changeChunkSize = (next) => { setChunkSize(next); onChunkSizeChange?.(next); };

  const progress = totalWords ? (Math.min(totalWords, wordIndex + current.wordCount) / totalWords) * 100 : 0;
  // Time left to finish, derived from the live `wpm` so it re-renders the moment
  // the slider or the +/- hotkeys change speed. The words still to come are the
  // ones after the chunk on screen.
  const remainingWords = Math.max(0, totalWords - wordIndex - current.wordCount);
  const remainingSec = (remainingWords * 60) / Math.max(60, wpm);

  if (!totalWords) {
    return (
      <div className={`bg-port-card border border-port-border rounded-lg p-6 text-center text-gray-500 ${compact ? '' : 'min-h-64'}`}>
        Paste or pass some text to start reading.
      </div>
    );
  }

  return (
    // The reader owns Space, the arrows and +/- while it is mounted, so no click
    // inside it may park focus on a button and take those keys over.
    <div className="bg-port-card border border-port-border rounded-lg overflow-hidden" {...noPointerFocusSurfaceProps}>
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
          <FocalSlot chunk={current.value} focalColor={focalColor} />
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
          {onBookmark && (
            <button
              type="button"
              onClick={() => onBookmark(wordIndex)}
              className="min-h-10 min-w-10 flex items-center justify-center rounded-lg border border-port-border text-gray-400 hover:text-white hover:bg-port-bg/60"
              title="Save bookmark (B)"
              aria-label="Save bookmark"
            >
              <Bookmark size={16} />
            </button>
          )}
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg border border-port-border text-gray-400 hover:text-white hover:bg-port-bg/60 ml-1"
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
              onChange={(e) => changeWpm(Number(e.target.value))}
              aria-label="Reading speed"
              className="w-28 sm:w-32 accent-port-accent"
            />
            <span className="font-mono text-gray-300 w-10 text-right">{wpm}</span>
          </label>
          <div className="flex items-center gap-1 border border-port-border rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => changeChunkSize(1)}
              className={`px-2 py-1 text-xs ${chunkSize === 1 ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              aria-pressed={chunkSize === 1}
              aria-label="Show one word at a time"
            >
              1w
            </button>
            <button
              type="button"
              onClick={() => changeChunkSize(2)}
              className={`px-2 py-1 text-xs ${chunkSize === 2 ? 'bg-port-accent/20 text-port-accent' : 'text-gray-400 hover:text-white'}`}
              aria-pressed={chunkSize === 2}
              aria-label="Show two words at a time"
            >
              2w
            </button>
          </div>
          <span className="font-mono text-gray-500">
            {Math.min(wordIndex + 1, totalWords)}/{totalWords} words · {formatCountdown(remainingSec)} left
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
// leaving its context. `inDialog` is what lets the reader keep its keys in here:
// its useKeyCapture claim otherwise stands down while an aria-modal layer is open,
// and Modal IS that layer. The claim runs in the capture phase, so Esc reaches
// onClose and never Modal's own bubble-phase close — the reader owns Esc here.
export function RapidReaderModal({ open, text, title, onClose, ...readerProps }) {
  // Aim the dialog's initial focus at the header ROW, not at the Close button
  // inside it. Focus otherwise lands on the first focusable descendant, and
  // Space on a focused button belongs to the browser — so the reader's own
  // Space (play/pause) would have dismissed the reader instead.
  const headerRef = useRef(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="xl"
      ariaLabel={title || 'Rapid Reader'}
      panelClassName="bg-port-card border border-port-border rounded-xl shadow-2xl"
      initialFocusRef={headerRef}
    >
      <div ref={headerRef} tabIndex={-1} className="flex items-center justify-between gap-2 px-4 py-2 border-b border-port-border">
        <div className="flex items-center gap-2 text-sm text-gray-300 truncate">
          <Zap size={14} className="text-port-accent shrink-0" />
          <span className="truncate">{title || 'Rapid Reader'}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
         
          className="min-h-[44px] min-w-[44px] flex items-center justify-center text-gray-400 hover:text-white"
          aria-label="Close rapid reader"
        >
          <X size={18} />
        </button>
      </div>
      <RapidReader text={text} onClose={onClose} autoPlay inDialog {...readerProps} />
    </Modal>
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
