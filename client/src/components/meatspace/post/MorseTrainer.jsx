import { useState, useEffect, useRef, useCallback } from 'react';
import { ArrowLeft, Radio, Headphones, Hand, EyeOff, CheckCircle, XCircle, Play, RefreshCw, Volume2, GitBranch, List as ListIcon, Ruler, Eraser } from 'lucide-react';
import useDrawerTab from '../../../hooks/useDrawerTab';
import { submitTrainingEntry, getTrainingStats, submitMorseRound, getMorseProgress, updateMorseLevel } from '../../../services/api';
import MorseProgressPanel from './MorseProgressPanel';

export const MORSE_TABLE = {
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
// Morse is timing-decoded rather than prefix-free, so a node can carry both a
// letter (e.g. E, T, A) AND have children for longer codes that extend it.
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

// Tidy tree layout: true leaves (nodes with no dah/dit children) get
// sequential x-slots in left-to-right (dah-then-dit) order; every internal
// node's x is the midpoint of its children. This replaces nested equal-split
// `flex-1` divs — which gave a missing branch the same width as a populated
// one at every depth, so a lightly-populated subtree several levels down
// could visually squeeze/shift everything above it, including the root —
// with positions derived from each subtree's real size. The root always
// lands at the midpoint of its two top branches and every node keeps a
// stable, non-overlapping slot regardless of how deep/sparse its subtree is.
function layoutMorseTree(root) {
  const nodes = [];
  const edges = [];
  let nextLeafX = 0;

  function visit(node, depth) {
    if (!node) return null;
    let x;
    const dahPos = visit(node.dah, depth + 1);
    const ditPos = visit(node.dit, depth + 1);
    const childXs = [dahPos, ditPos].filter(Boolean).map((p) => p.x);
    if (childXs.length === 0) {
      x = nextLeafX;
      nextLeafX += 1;
    } else {
      x = childXs.reduce((a, b) => a + b, 0) / childXs.length;
    }
    if (dahPos) edges.push({ x1: x, y1: depth, x2: dahPos.x, y2: depth + 1, childCode: node.dah.code });
    if (ditPos) edges.push({ x1: x, y1: depth, x2: ditPos.x, y2: depth + 1, childCode: node.dit.code });
    const pos = { x, depth, node };
    nodes.push(pos);
    return pos;
  }

  visit(root, 0);
  const maxDepth = nodes.reduce((max, n) => Math.max(max, n.depth), 0);
  return { nodes, edges, width: Math.max(1, nextLeafX), maxDepth };
}

const MORSE_TREE_LAYOUT = layoutMorseTree(MORSE_TREE);
const TREE_SLOT_W = 26;
const TREE_ROW_H = 34;

const KOCH_ORDER = ['K', 'M', 'U', 'R', 'E', 'S', 'N', 'A', 'P', 'T', 'L', 'W', 'I', '.', 'J', 'Z', '=', 'F', 'O', 'Y', ',', 'V', 'G', '5', '/', 'Q', '9', '2', 'H', '3', '8', 'B', '?', '4', '7', 'C', '1', 'D', '6', '0', 'X'];

const PREFS_KEY = 'portos-post-morse-prefs';
// Base Koch level (K, M — the two-character start of the pool). localStorage is
// now a write-through cache; the server holds the authoritative level. A fresh
// install with no server level and no cache stays at this base (no regression).
const DEFAULT_KOCH_LEVEL = 2;
const DEFAULT_PREFS = { wpm: 18, effectiveWpm: 18, hz: 700, kochLevel: DEFAULT_KOCH_LEVEL, bestAccuracy: 0 };

// Tone envelope ramp — fast enough to avoid clicks, slow enough to feel like a key
const RAMP_SEC = 0.005;
const TONE_GAIN = 0.25;

export const MODES = [
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
    id: 'head-copy',
    label: 'Head Copy',
    icon: EyeOff,
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/20',
    description: 'Audio-only — no on-screen code hints or cheat sheet',
    example: 'Same Koch pool, pure recall — nothing to look at',
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

// Training log module name — passed as `module` on every submitTrainingEntry
// call from this trainer so POST's training stats can group Morse practice
// under one key regardless of which mode logged it.
const TRAINING_MODULE = 'morse';

// Mirrors the streakGlyph helper in PostSessionLauncher.jsx/DailyPostWidget.jsx
// (small enough that a shared util would be more indirection than reuse).
const streakGlyph = (streak) => (streak >= 7 ? '🔥' : streak >= 3 ? '⚡' : '✨');

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
  const ensureCtx = useCallback(async () => {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    // Autoplay policy starts the context suspended until a user gesture — and on
    // iOS Safari resume() is async, so we MUST await it before scheduling any
    // oscillator. Firing resume() without awaiting (the old behavior) laid tones
    // down against a still-suspended clock: silent on mobile Safari. Mirrors the
    // await-resume idiom in metronome.js / scorePlayback.js / songPlayback.js.
    if (ctxRef.current.state === 'suspended') await ctxRef.current.resume();
    return ctxRef.current;
  }, []);
  useEffect(() => () => {
    if (ctxRef.current) ctxRef.current.close();
    ctxRef.current = null;
  }, []);
  return ensureCtx;
}

// `enabled` defaults to false so callers must explicitly opt in to attaching
// the global spacebar listener — it's only safe in Send mode. In other modes
// it would compete with text input and suppress the voice-widget push-to-talk
// hotkey via stopImmediatePropagation.
function useKeyingDecoder({ unitMs, hz, ensureCtx, enabled = false }) {
  const oscRef = useRef(null);
  const gainRef = useRef(null);
  const pressStartRef = useRef(0);
  const lastReleaseRef = useRef(0);
  const flushTimerRef = useRef(null);
  const wordTimerRef = useRef(null);
  const patternRef = useRef('');
  // Per-letter completion log (send mode): each decoded letter's char + the
  // performance.now() timestamp it flushed at, so SendDrill can derive a
  // per-character response time (inter-letter delta) for the round it submits.
  const letterLogRef = useRef([]);
  // Mirror of `pressing` state read by beginPress/endPress so those callbacks
  // stay referentially stable — the global keydown/keyup listener effect
  // depends on them, and re-running per keystroke would tear down the
  // just-scheduled flush timers and cut off the active tone mid-press.
  const pressingRef = useRef(false);
  // Bumped once per beginPress so a startTone whose resume await settles after a
  // newer press started can tell it's been superseded and bail.
  const toneGenRef = useRef(0);

  const [pattern, setPattern] = useState('');
  const [decoded, setDecoded] = useState('');
  const [pressing, setPressing] = useState(false);

  const startTone = useCallback(async () => {
    const gen = ++toneGenRef.current;
    const ctx = await ensureCtx();
    // A fast tap can release (endPress → stopTone), or a newer press can start,
    // before the first-press-only resume await settles. Bail if the key is no
    // longer held (`!pressingRef.current`) OR a newer press superseded this one
    // (`gen !== toneGenRef.current`) — a bare boolean can't distinguish the two,
    // so two overlapping starts would both create an oscillator and orphan the
    // first, leaving it droning with no matching stop.
    if (!pressingRef.current || gen !== toneGenRef.current) return;
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
    // Read the clock straight off the live oscillator's context — a tone is only
    // playing on an already-running context, so there's nothing to resume here
    // (and stopTone stays synchronous, which endPress/clear/cleanup rely on).
    const now = osc.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + RAMP_SEC);
    osc.stop(now + 0.02);
    osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    oscRef.current = null;
    gainRef.current = null;
  }, []);

  const flushLetter = useCallback(() => {
    const buf = patternRef.current;
    if (!buf) return;
    const ch = MORSE_LOOKUP[buf] || '?';
    letterLogRef.current.push({ char: ch, at: performance.now() });
    setDecoded((d) => d + ch);
    patternRef.current = '';
    setPattern('');
  }, []);

  const beginPress = useCallback(() => {
    if (pressingRef.current) return;
    if (flushTimerRef.current) { clearTimeout(flushTimerRef.current); flushTimerRef.current = null; }
    if (wordTimerRef.current) { clearTimeout(wordTimerRef.current); wordTimerRef.current = null; }
    pressingRef.current = true;
    setPressing(true);
    pressStartRef.current = performance.now();
    startTone();
  }, [startTone]);

  const endPress = useCallback(() => {
    if (!pressingRef.current) return;
    pressingRef.current = false;
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
  }, [stopTone, unitMs, flushLetter]);

  // Reset every piece of keying state — including in-flight press tracking and
  // the audible tone — so a missed keyup or a mid-keying mode switch can't leave
  // `pressing` stuck true (which would block the next beginPress).
  const clear = useCallback(() => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    if (wordTimerRef.current) clearTimeout(wordTimerRef.current);
    flushTimerRef.current = null;
    wordTimerRef.current = null;
    patternRef.current = '';
    letterLogRef.current = [];
    pressStartRef.current = 0;
    lastReleaseRef.current = 0;
    stopTone();
    pressingRef.current = false;
    setPressing(false);
    setPattern('');
    setDecoded('');
  }, [stopTone]);

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
      // If the user mode-switches mid-keydown, the matching keyup fires after
      // the listener is gone — reset the press tracking so the next mode
      // change doesn't leave beginPress permanently blocked by a stuck ref.
      pressingRef.current = false;
      setPressing(false);
    };
  }, [beginPress, endPress, stopTone, enabled]);

  // getLetterLog exposes the ref's current array without making it reactive —
  // SendDrill reads it once at check time, so a ref (no re-render) is correct.
  const getLetterLog = useCallback(() => letterLogRef.current, []);

  return { pattern, decoded, pressing, beginPress, endPress, clear, getLetterLog };
}

// Valid `:mode` subroute segments. Anything else (stale/deleted deep link)
// falls through to the mode grid rather than a blank panel.
export const MORSE_MODE_IDS = MODES.map((m) => m.id);

// `mode` is the routed `:mode` segment (`/post/morse/:mode`), validated by the
// caller (PostTab) to one of MORSE_MODE_IDS or null — the URL is the single
// source of truth for which drill is open, so there is no local mode state.
export default function MorseTrainer({ mode = null, onSelectMode, onExitMode, onBack }) {
  const [prefs, setPrefs] = useState(loadPrefs);
  const [trainingStats, setTrainingStats] = useState(null);
  // Bumped after each round submit so the progress panel refetches its trends /
  // confusion matrix without a manual reload.
  const [progressRefresh, setProgressRefresh] = useState(0);
  const ensureCtx = useAudioContext();
  const unitMs = 1.2 / prefs.wpm * 1000;
  const keying = useKeyingDecoder({ unitMs, hz: prefs.hz, ensureCtx, enabled: mode === 'send' });
  // Head Copy reuses CopyDrill's whole pipeline (Koch pool, round scoring,
  // level unlock) minus the on-screen morse hints and the reference cheat
  // sheet — the only meaningful difference the issue asks for.
  const showReference = mode !== 'head-copy';

  // Hydrate the authoritative Koch level from the server (localStorage is now a
  // write-through cache). One-time adoption: if the server has never had a level
  // and this browser's cached level is beyond the base, push it up (adopt:true —
  // the server ignores it if another device already set a real level).
  useEffect(() => {
    let cancelled = false;
    getMorseProgress(30, { silent: true })
      .then(async (p) => {
        if (cancelled || !p) return;
        if (!p.kochLevelSet) {
          const cachedLevel = loadPrefs().kochLevel;
          if (cachedLevel > DEFAULT_KOCH_LEVEL) {
            const res = await updateMorseLevel({ kochLevel: cachedLevel, adopt: true }, { silent: true }).catch(() => null);
            if (!cancelled && res?.kochLevel) {
              setPrefs((prev) => { const n = { ...prev, kochLevel: res.kochLevel }; savePrefs(n); return n; });
            }
            return;
          }
        }
        if (typeof p.kochLevel === 'number') {
          setPrefs((prev) => { const n = { ...prev, kochLevel: p.kochLevel }; savePrefs(n); return n; });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  function updatePrefs(patch) {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      if (next.effectiveWpm > next.wpm) next.effectiveWpm = next.wpm;
      savePrefs(next);
      // Persist a level change to the server (write-through). Settings ride along
      // so a level advance/reset also syncs the current speed/tone across devices.
      if (patch.kochLevel != null && patch.kochLevel !== prev.kochLevel) {
        updateMorseLevel(
          { kochLevel: patch.kochLevel, settings: { wpm: next.wpm, farnsworthWpm: next.effectiveWpm, toneHz: next.hz } },
          { silent: true },
        ).catch(() => {});
      }
      return next;
    });
  }

  function resetProgress() {
    updatePrefs({ kochLevel: DEFAULT_KOCH_LEVEL, bestAccuracy: 0 });
  }

  // Fire-and-forget per-round submit (server persists per-item sent→guessed
  // results for the trends + confusion matrix). Refreshes the panel on success.
  const submitRound = useCallback((round) => {
    submitMorseRound(round, { silent: true })
      .then(() => setProgressRefresh((n) => n + 1))
      .catch(() => {});
  }, []);

  // Fetches the training log's 30-day view and reduces it to what this trainer
  // shows: overall training streak (shared across every POST training-mode
  // drill, not Morse-exclusive) plus a Morse-only practice count/accuracy.
  // byDrill only reports a per-drill-type accuracy%, not raw correct/question
  // counts, so morseAccuracy is a session-count-weighted average across the
  // morse-copy/morse-head-copy/morse-send buckets — not a true question-level average.
  const refreshTrainingStats = useCallback(() => {
    getTrainingStats(30)
      .then((stats) => {
        const morseEntries = Object.entries(stats?.byDrill || {}).filter(([key]) => key.startsWith(`${TRAINING_MODULE}:`));
        const morseSessions = morseEntries.reduce((sum, [, d]) => sum + (d.practiceCount || 0), 0);
        const weightedAccuracySum = morseEntries.reduce((sum, [, d]) => sum + (d.accuracy || 0) * (d.practiceCount || 0), 0);
        const morseAccuracy = morseSessions > 0 ? Math.round(weightedAccuracySum / morseSessions) : null;
        setTrainingStats({ currentStreak: stats?.currentStreak ?? 0, morseSessions, morseAccuracy });
      })
      .catch(() => {});
  }, []);

  useEffect(() => { refreshTrainingStats(); }, [refreshTrainingStats]);

  // Fire-and-forget training-log write, mirroring the existing
  // usePostSession.js training-mode pattern (silent — a failed background log
  // shouldn't interrupt practice). Refreshes the displayed stats on success.
  const logTraining = useCallback((patch) => {
    submitTrainingEntry({ module: TRAINING_MODULE, ...patch })
      .then(() => refreshTrainingStats())
      .catch(() => {});
  }, [refreshTrainingStats]);

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

      <div className={`grid grid-cols-1 ${showReference ? 'xl:grid-cols-[minmax(0,1fr)_24rem]' : ''} gap-6`}>
        <div className="space-y-6 min-w-0 max-w-2xl">
          <SettingsPanel prefs={prefs} updatePrefs={updatePrefs} onResetProgress={resetProgress} trainingStats={trainingStats} />
          {!mode && <ModeGrid onPick={onSelectMode} />}
          {mode === 'copy' && (
            <CopyDrill prefs={prefs} updatePrefs={updatePrefs} ensureCtx={ensureCtx} onExit={onExitMode} onSessionComplete={logTraining} onRoundSubmit={submitRound} />
          )}
          {mode === 'head-copy' && (
            <CopyDrill prefs={prefs} updatePrefs={updatePrefs} ensureCtx={ensureCtx} onExit={onExitMode} onSessionComplete={logTraining} onRoundSubmit={submitRound} headCopy />
          )}
          {mode === 'send' && (
            <SendDrill keying={keying} onExit={onExitMode} onSessionComplete={logTraining} onRoundSubmit={submitRound} />
          )}
          {!mode && <MorseProgressPanel refreshKey={progressRefresh} />}
        </div>
        {showReference && <ReferenceWidget keying={keying} mode={mode} />}
      </div>
    </div>
  );
}

function SettingsPanel({ prefs, updatePrefs, onResetProgress, trainingStats }) {
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
      <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-xs text-gray-500 border-t border-port-border pt-3">
        <span>
          Koch level: <span className="text-white font-mono">{prefs.kochLevel}</span> /{' '}
          <span className="text-gray-400">{KOCH_ORDER.length}</span> ·{' '}
          Best round: <span className="text-white font-mono">{prefs.bestAccuracy}%</span>
          {trainingStats && (
            <>
              {' '}· <span aria-hidden="true">{streakGlyph(trainingStats.currentStreak)}</span> Training streak:{' '}
              <span className="text-white font-mono">{trainingStats.currentStreak}</span>d
              {trainingStats.morseSessions > 0 && (
                <>
                  {' '}· Morse logged: <span className="text-white font-mono">{trainingStats.morseSessions}</span>
                  {trainingStats.morseAccuracy != null && (
                    <> (<span className="text-white font-mono">{trainingStats.morseAccuracy}%</span> avg)</>
                  )}
                </>
              )}
            </>
          )}
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

const REFERENCE_VIEW_IDS = REFERENCE_VIEWS.map((v) => v.id);

function ReferenceWidget({ keying, mode }) {
  // Reference tab lives in the `?ref=` search param so it's deep-linkable and
  // survives reload/share; a stale value degrades to 'tree'.
  const [view, setView] = useDrawerTab('ref', 'tree', REFERENCE_VIEW_IDS);
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
          {view === 'tree' && <TreeView currentPath={currentPath} mode={mode} />}
          {view === 'length' && <LengthView currentPath={currentPath} />}
          {view === 'list' && <ListView currentPath={currentPath} />}
        </div>
      </div>

      {mode === 'send' && <KeyPad keying={keying} />}
    </div>
  );
}

export function isNodeOnPath(node, currentPath) {
  // Root's placeholder char ('·') is truthy but isn't a real decoded
  // character — gate on `currentPath.length > 0` too so an idle/empty path
  // (reference-only view, or before the first key press) never lights up
  // the root as if it were the live-keyed match.
  const matched = !!node.char && currentPath.length > 0 && currentPath === node.code;
  const onPath = currentPath.length > 0 && currentPath.startsWith(node.code) && node.code !== currentPath;
  return { matched, onPath };
}

function TreeNodeLabel({ x, depth, node, currentPath }) {
  const { matched, onPath } = isNodeOnPath(node, currentPath);
  const display = node.char || (node.code === '' ? '·' : '');
  return (
    <div
      className={`absolute -translate-x-1/2 -translate-y-1/2 whitespace-nowrap text-[11px] font-mono px-1.5 py-0.5 rounded transition-colors ${
        matched ? 'bg-port-accent text-white font-bold' :
        onPath ? 'text-port-accent bg-port-bg' :
        display ? 'text-gray-300 bg-port-bg' : 'text-gray-700 bg-port-bg'
      }`}
      style={{ left: x * TREE_SLOT_W + TREE_SLOT_W / 2, top: depth * TREE_ROW_H + TREE_ROW_H / 2 }}
      title={node.code || 'start'}
    >
      {display || '·'}
    </div>
  );
}

function TreeView({ currentPath, mode }) {
  const { nodes, edges, width, maxDepth } = MORSE_TREE_LAYOUT;
  const pixelWidth = width * TREE_SLOT_W;
  const pixelHeight = (maxDepth + 1) * TREE_ROW_H;

  return (
    <div>
      <div className="flex items-center justify-between text-[10px] uppercase tracking-wide text-gray-500 mb-2">
        <span>← dah</span>
        <span>start</span>
        <span>dit →</span>
      </div>
      <div className="overflow-x-auto pb-1">
        <div className="relative mx-auto" style={{ width: pixelWidth, height: pixelHeight }}>
          <svg className="absolute inset-0 overflow-visible" width={pixelWidth} height={pixelHeight}>
            {edges.map((e, i) => {
              const highlighted = currentPath.length > 0 && currentPath.startsWith(e.childCode);
              return (
                <line
                  key={i}
                  x1={e.x1 * TREE_SLOT_W + TREE_SLOT_W / 2}
                  y1={e.y1 * TREE_ROW_H + TREE_ROW_H / 2}
                  x2={e.x2 * TREE_SLOT_W + TREE_SLOT_W / 2}
                  y2={e.y2 * TREE_ROW_H + TREE_ROW_H / 2}
                  className={highlighted ? 'stroke-port-accent' : 'stroke-port-border'}
                  strokeWidth={highlighted ? 2 : 1}
                />
              );
            })}
          </svg>
          {nodes.map(({ x, depth, node }) => (
            <TreeNodeLabel key={node.code} x={x} depth={depth} node={node} currentPath={currentPath} />
          ))}
        </div>
      </div>
      <p className="text-[10px] text-gray-500 mt-3">
        {mode === 'send'
          ? "Tap or hold space to key. The path you're on lights up."
          : 'Reference only — start a Send drill to see your live keying path.'}
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
        onMouseLeave={keying.endPress}
        onTouchStart={(e) => { e.preventDefault(); keying.beginPress(); }}
        onTouchEnd={(e) => { e.preventDefault(); keying.endPress(); }}
        className={`w-full select-none py-6 rounded-lg border-2 font-mono text-base transition-colors ${
          keying.pressing ? 'border-port-accent bg-port-accent/20 text-port-accent' : 'border-port-border bg-port-bg text-gray-400 hover:border-port-accent'
        }`}
      >
        {keying.pressing ? '▮ KEYING' : 'TAP / HOLD SPACE'}
      </button>
      <p className="text-[10px] text-gray-500 text-center">
        Tap short for ·, hold for —. Your decoded text appears in the drill.
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

// Flatten per-question copy results ({ prompt, guess, correct, responseMs }) into
// per-character sent→guessed items for the server's confusion matrix. Aligned
// positionally over the LONGER of prompt/guess so nothing is silently dropped:
//   - a missing/short guess char yields guessed '' (a miss, scored wrong);
//   - an EXTRA typed char beyond the prompt yields sent '' (an insertion). An
//     insertion has no transmitted character, so the server excludes empty-sent
//     items from the confusion matrix / per-character mastery, but still counts
//     them in the round's accuracy — so a `K`→`KM` round reads as an error, not a
//     perfect copy. The question's responseMs is attributed to each character.
export function resultsToItems(results) {
  const items = [];
  for (const r of results) {
    const promptChars = (r.prompt || '').toUpperCase().split('');
    const guessChars = (r.guess || '').toUpperCase().split('');
    const len = Math.max(promptChars.length, guessChars.length);
    for (let i = 0; i < len; i++) {
      const sent = promptChars[i] ?? '';
      const guessed = guessChars[i] ?? '';
      items.push({ sent, guessed, correct: sent === guessed, responseMs: r.responseMs ?? 0 });
    }
  }
  return items;
}

function CopyDrill({ prefs, updatePrefs, ensureCtx, onExit, onSessionComplete, onRoundSubmit, headCopy = false }) {
  const [prompt, setPrompt] = useState('');
  const [input, setInput] = useState('');
  const [results, setResults] = useState([]);
  const [feedback, setFeedback] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [done, setDone] = useState(false);
  const inputRef = useRef(null);
  const roundStartRef = useRef(0);
  // Set when a prompt finishes playing; drives per-question responseMs (time from
  // "audio done" to the user's submit) recorded per character in the round.
  const questionStartRef = useRef(0);
  // Re-entrancy guard. On the first play of a session `ensureCtx()` awaits the
  // iOS audio-unlock, and `prompt`/`playing` aren't set until after it — so the
  // Start Round / New Round button stays live during that window. A second tap
  // would otherwise start a second overlapping playPrompt, scheduling two Morse
  // prompts over each other with the UI tracking only whichever set state last.
  // A ref (not `playing` state) because it must gate synchronously, before the
  // first await, where a state update wouldn't have rendered yet.
  const playingRef = useRef(false);

  async function startRound() {
    if (playingRef.current) return;
    setResults([]);
    setFeedback(null);
    setDone(false);
    roundStartRef.current = Date.now();
    await playPrompt(true);
  }

  async function playPrompt(isNew) {
    if (playingRef.current) return;
    playingRef.current = true;
    const ctx = await ensureCtx();
    const text = isNew ? pickKochPrompt(prefs.kochLevel) : prompt;
    if (isNew) {
      setPrompt(text);
      setInput('');
      setFeedback(null);
    }
    setPlaying(true);
    await playMorse(ctx, text, prefs);
    setPlaying(false);
    playingRef.current = false;
    questionStartRef.current = Date.now();
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  function submit() {
    if (!prompt) return;
    const guess = input.trim().toUpperCase();
    const correct = guess === prompt;
    const responseMs = questionStartRef.current ? Date.now() - questionStartRef.current : 0;
    const next = [...results, { prompt, guess, correct, responseMs }];
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
    const durationMs = roundStartRef.current ? Date.now() - roundStartRef.current : 0;
    onSessionComplete?.({
      drillType: headCopy ? 'morse-head-copy' : 'morse-copy',
      questionCount: rs.length,
      correctCount,
      totalMs: durationMs,
    });
    // Persist the round server-side with per-character sent→guessed pairs (each
    // prompt/guess is aligned positionally so a 5-char group yields 5 items) —
    // the raw material for the confusion matrix and per-character mastery.
    onRoundSubmit?.({
      mode: headCopy ? 'head-copy' : 'copy',
      kochLevel: prefs.kochLevel,
      wpm: prefs.wpm,
      farnsworthWpm: prefs.effectiveWpm,
      durationMs,
      items: resultsToItems(rs),
    });
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
        <p className="text-xs text-gray-500">
          {headCopy
            ? 'Listen to a 10-question round. No code hints on the results screen — pure recall. Hit 90% to unlock the next letter.'
            : 'Listen to a 10-question round. Hit 90% to unlock the next letter.'}
        </p>
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
            {!headCopy && (
              <div className="font-mono text-port-accent/70 text-base tracking-widest">
                {feedback.prompt.split('').map((c) => MORSE_TABLE[c] || '').join('   ')}
              </div>
            )}
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

function SendDrill({ keying, onExit, onSessionComplete, onRoundSubmit }) {
  const [prompt, setPrompt] = useState(() => pickSendPrompt());
  const [feedback, setFeedback] = useState(null);
  const promptStartRef = useRef(Date.now());

  // Drop any stale keying state from a prior session so "Your sending" starts empty.
  const { clear: clearKeying } = keying;
  useEffect(() => {
    clearKeying();
  }, [clearKeying]);

  function decodeNow() {
    const target = prompt.toUpperCase();
    const got = keying.decoded.replace(/\s+/g, ' ').trim().toUpperCase();
    const correct = got === target;
    setFeedback({ correct, decoded: got, target });
    const durationMs = Date.now() - promptStartRef.current;
    onSessionComplete?.({
      drillType: 'morse-send',
      questionCount: 1,
      correctCount: correct ? 1 : 0,
      totalMs: durationMs,
    });
    // Record per-character keying accuracy + timing. sent = target char, guessed =
    // what the decoder resolved at that position. responseMs is the inter-letter
    // keying interval (letterLog is on the same performance.now() clock, so only
    // deltas between consecutive letters are meaningful — first char has none).
    const targetChars = target.replace(/\s+/g, '').split('');
    const decodedChars = got.replace(/\s+/g, '').split('');
    const log = keying.getLetterLog?.() || [];
    // Align over the LONGER sequence (like copy mode) so an over-long send —
    // e.g. target `KM` keyed as `KMM` — records the surplus keyed character as an
    // empty-sent insertion error instead of silently scoring a perfect send.
    const len = Math.max(targetChars.length, decodedChars.length);
    const items = [];
    for (let i = 0; i < len; i++) {
      const sent = targetChars[i] ?? '';
      const guessed = decodedChars[i] ?? '';
      const at = log[i]?.at;
      const prevAt = log[i - 1]?.at;
      const responseMs = at != null && prevAt != null ? Math.max(0, Math.round(at - prevAt)) : 0;
      items.push({ sent, guessed, correct: sent === guessed, responseMs });
    }
    if (items.length > 0) {
      onRoundSubmit?.({ mode: 'send', durationMs, items });
    }
  }

  function nextPrompt() {
    keying.clear();
    setFeedback(null);
    setPrompt(pickSendPrompt());
    promptStartRef.current = Date.now();
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
