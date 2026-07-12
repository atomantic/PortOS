// Chord detection for the MIDI visualization UI. Pure helpers: given the
// normalized note list from midiNotes.js, find time windows where ≥2 distinct
// pitch classes sound simultaneously and label each window with a compact
// chord symbol (Cmaj7, Am, G/B, …) — or, when no dictionary shape matches,
// the sorted pitch-class names (never a wrong guess). No canvas/React.

import { midiNoteName } from './pianoKeyboard.js';

const PITCH_CLASS_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Minimum overlap for a window to count as an intentional chord rather than a
// passing-note smear (see issue #2477 — 40–80ms band; midpoint chosen).
export const MIN_CHORD_WINDOW_SEC = 0.06;

// Interval sets (semitones above the root, root included as 0), most-specific
// first so a maj7 isn't reported as its embedded triad.
const CHORD_SHAPES = [
  { intervals: [0, 4, 7, 11], suffix: 'maj7' },
  { intervals: [0, 4, 7, 10], suffix: '7' },
  { intervals: [0, 3, 7, 10], suffix: 'm7' },
  { intervals: [0, 3, 6, 10], suffix: 'm7b5' },
  { intervals: [0, 3, 6, 9], suffix: 'dim7' },
  { intervals: [0, 2, 4, 7], suffix: 'add9' },
  { intervals: [0, 4, 7], suffix: '' },
  { intervals: [0, 3, 7], suffix: 'm' },
  { intervals: [0, 3, 6], suffix: 'dim' },
  { intervals: [0, 4, 8], suffix: 'aug' },
  { intervals: [0, 2, 7], suffix: 'sus2' },
  { intervals: [0, 5, 7], suffix: 'sus4' },
];

const pc = (midi) => ((midi % 12) + 12) % 12;
const sameSet = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Name a set of pitch classes as a chord symbol.
 *
 * @param {number[]} pcs — distinct pitch classes (0–11).
 * @param {number} bassPc — pitch class of the lowest sounding note.
 * @returns {string} chord symbol (`Cmaj7`, `Am`, `C/E`), or space-joined
 *   pitch-class names (`C E G#`) when no shape matches, or '' for <2 pcs.
 */
export const nameChord = (pcs, bassPc) => {
  const unique = [...new Set(pcs)].sort((a, b) => a - b);
  if (unique.length < 2) return '';
  // Try every pitch class as the root; prefer the bass note as root so
  // inversions come out as slash chords rather than a different quality.
  const roots = [bassPc, ...unique.filter((p) => p !== bassPc)];
  for (const root of roots) {
    const intervals = unique.map((p) => (p - root + 12) % 12).sort((a, b) => a - b);
    const shape = CHORD_SHAPES.find((s) => sameSet(s.intervals, intervals));
    if (shape) {
      const name = `${PITCH_CLASS_NAMES[root]}${shape.suffix}`;
      return root === bassPc ? name : `${name}/${PITCH_CLASS_NAMES[bassPc]}`;
    }
  }
  return unique.map((p) => PITCH_CLASS_NAMES[p]).join(' ');
};

/**
 * Sweep the note list for chord windows — maximal spans where the set of
 * simultaneously-sounding pitch classes stays constant and has ≥2 members.
 *
 * @param {Array<{midi:number,startSec:number,durationSec:number}>} notes —
 *   normalized notes from parseMidiFile (any order).
 * @param {object} [opts]
 * @param {number} [opts.minWindowSec=MIN_CHORD_WINDOW_SEC] — windows shorter
 *   than this are dropped as passing-note noise.
 * @returns {Array<{startSec:number,endSec:number,label:string,midis:number[]}>}
 *   consecutive windows with the same label are merged.
 */
export const detectChordWindows = (notes, { minWindowSec = MIN_CHORD_WINDOW_SEC } = {}) => {
  const edges = [];
  (notes || []).forEach((n) => {
    if (!Number.isFinite(n.midi) || !Number.isFinite(n.startSec)) return;
    edges.push({ t: n.startSec, midi: n.midi, on: true });
    edges.push({ t: n.startSec + Math.max(n.durationSec || 0, 0.001), midi: n.midi, on: false });
  });
  if (!edges.length) return [];
  // Offs before ons at the same instant so back-to-back notes don't merge.
  edges.sort((a, b) => a.t - b.t || (a.on === b.on ? 0 : a.on ? 1 : -1));

  const sounding = new Map(); // midi → active count (handles overlapping same-pitch notes)
  const windows = [];
  let spanStart = null;
  let spanMidis = null;
  const closeSpan = (t) => {
    if (spanStart == null) return;
    if (t - spanStart >= minWindowSec) {
      const midis = [...spanMidis].sort((a, b) => a - b);
      const label = nameChord(midis.map(pc), pc(midis[0]));
      if (label) windows.push({ startSec: spanStart, endSec: t, label, midis });
    }
    spanStart = null;
    spanMidis = null;
  };

  let i = 0;
  while (i < edges.length) {
    const t = edges[i].t;
    // Apply every edge at this timestamp before re-evaluating the set.
    while (i < edges.length && edges[i].t === t) {
      const e = edges[i];
      const count = (sounding.get(e.midi) || 0) + (e.on ? 1 : -1);
      if (count > 0) sounding.set(e.midi, count);
      else sounding.delete(e.midi);
      i += 1;
    }
    const midis = [...sounding.keys()];
    const pcs = new Set(midis.map(pc));
    if (pcs.size >= 2) {
      const key = midis.sort((a, b) => a - b).join(',');
      const prevKey = spanMidis ? [...spanMidis].sort((a, b) => a - b).join(',') : null;
      if (key !== prevKey) {
        closeSpan(t);
        spanStart = t;
        spanMidis = new Set(midis);
      }
    } else {
      closeSpan(t);
    }
  }
  closeSpan(edges[edges.length - 1].t);

  // Merge adjacent windows that resolved to the same label (retriggered chords).
  const merged = [];
  windows.forEach((w) => {
    const last = merged[merged.length - 1];
    if (last && last.label === w.label && w.startSec - last.endSec < 0.05) {
      last.endSec = w.endSec;
      last.midis = [...new Set([...last.midis, ...w.midis])].sort((a, b) => a - b);
    } else {
      merged.push({ ...w });
    }
  });
  return merged;
};

/** Human-readable pitch names for a chord window's tooltip (`C4 E4 G4`). */
export const chordNoteNames = (midis) => (midis || []).map((m) => midiNoteName(m)).join(' ');
