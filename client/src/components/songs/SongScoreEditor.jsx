/**
 * SongScoreEditor — the editing surface for a song's sheet music. A plain
 * textarea holds the PortOS lead-sheet notation (see scoreNotation.js for the
 * format); the parsed score renders live in a <ScoreSheet> above it so the user
 * sees the staff update as they type. No third-party music editor — the textarea
 * is the editor, the parser is the bridge, the SVG is the preview.
 *
 * Below the textarea: a collapsible format legend (so the notation is
 * discoverable without leaving the page) and inline parse feedback — per-measure
 * beat totals that don't match the time signature are flagged, and unrecognized
 * tokens are listed. Feedback is advisory: a malformed token is skipped, never
 * blocks rendering the rest.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import { Music, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';
import ScoreSheet from './ScoreSheet.jsx';
import SingToScore from './SingToScore.jsx';
import { parseScore } from '../../lib/scoreNotation.js';

const PLACEHOLDER = `clef: treble
key: C
time: 4/4
tempo: 68

| [C] E4q(If) G4q(you) G4q(miss) G4q(the) | [Am] A4h(train) G4q(I'm) E4q(on) |`;

const LEGEND = [
  ['Header', 'clef: treble · key: C · time: 4/4 · tempo: 68 — one per line, before the music.'],
  ['Measures', 'Separate bars with | (a leading/trailing | is fine). Notes are space-separated within a bar.'],
  ['Pitch', 'Letter A–G + accidental (# b n) + octave. C4 is middle C. e.g. C4, F#4, Bb3.'],
  ['Duration', 'w h q e s t = whole, half, quarter, eighth, sixteenth, 32nd. Append . for a dot (q. = 1.5 beats).'],
  ['Rest', 'r + duration — rq, rh, re. (no pitch, no lyric).'],
  ['Chord', '[C] before a note draws the symbol above it — [Am], [G7], [F/A].'],
  ['Lyric', '(word) after a note draws it underneath. Use a trailing - for a held syllable: (whis-) (tle).'],
];

export default function SongScoreEditor({ value, onChange }) {
  const [showLegend, setShowLegend] = useState(false);
  const score = useMemo(() => parseScore(value || ''), [value]);
  const textareaRef = useRef(null);
  // Track the textarea's current selection so "Replace selection" knows whether
  // any text is selected and where. Updated on select/keyup/mouseup/blur.
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  const syncSelection = useCallback(() => {
    const el = textareaRef.current;
    if (el) setSelection({ start: el.selectionStart, end: el.selectionEnd });
  }, []);

  // Insert transcribed notation from Sing-to-score: either append a new line of
  // measures to the end of the score, or replace the current selection in place.
  const insertNotation = useCallback((text, mode) => {
    const current = value || '';
    if (mode === 'replace' && selection.end > selection.start) {
      const next = current.slice(0, selection.start) + text + current.slice(selection.end);
      onChange(next);
      return;
    }
    // Append: ensure a newline before the new measures unless the score is empty.
    const sep = current.trim() ? `${current.replace(/\s+$/, '')}\n` : current;
    onChange(`${sep}${text}`);
  }, [value, selection, onChange]);

  const hasSelection = selection.end > selection.start;

  // Measures whose beat total doesn't match the time signature — a gentle nudge,
  // not an error (a pickup bar or a deliberate free bar is legitimate).
  const beatWarnings = useMemo(() => {
    const target = score.time.beats * (4 / score.time.beatValue);
    return score.measures
      .map((m, i) => ({ i: i + 1, beats: m.beats, notes: m.notes.length }))
      .filter((m) => m.notes > 0 && Math.abs(m.beats - target) > 0.001);
  }, [score]);

  const hasMusic = score.measures.some((m) => m.notes.length > 0);
  const inputCls = 'w-full bg-port-bg border border-port-border rounded-lg px-3 py-2 text-sm text-white focus:border-port-accent focus:outline-none';

  return (
    <section>
      <div className="flex items-center justify-between mb-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Music size={15} className="text-port-accent" /> Sheet music
        </h2>
        <button
          type="button"
          onClick={() => setShowLegend((s) => !s)}
          className="flex items-center gap-1 text-xs text-gray-400 hover:text-white"
        >
          {showLegend ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Format guide
        </button>
      </div>

      {/* Live preview — the staff renders from whatever currently parses. */}
      {hasMusic && (
        <div className="bg-port-card border border-port-border rounded-lg p-3 mb-2 overflow-x-auto">
          <ScoreSheet text={value} />
        </div>
      )}

      <label htmlFor="score" className="block text-xs text-gray-400 mb-1">
        Notation — melody, chords & lyrics in PortOS lead-sheet format
      </label>
      <textarea
        id="score"
        ref={textareaRef}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        onSelect={syncSelection}
        onKeyUp={syncSelection}
        onMouseUp={syncSelection}
        onBlur={syncSelection}
        placeholder={PLACEHOLDER}
        rows={8}
        spellCheck={false}
        className={`${inputCls} font-mono leading-relaxed`}
      />

      {/* Sing a melody → transcribe it into the notation above. */}
      <div className="mt-3">
        <SingToScore
          value={value || ''}
          tempo={score.tempo}
          musicKey={score.key}
          hasSelection={hasSelection}
          onInsert={insertNotation}
        />
      </div>

      {/* Parse feedback — beat mismatches and unrecognized tokens. */}
      {(beatWarnings.length > 0 || score.errors.length > 0) && (
        <div className="mt-2 space-y-1">
          {beatWarnings.map((w) => (
            <p key={`beat-${w.i}`} className="flex items-center gap-1.5 text-xs text-port-warning">
              <AlertTriangle size={12} className="shrink-0" />
              Measure {w.i}: {w.beats} beats (time signature expects {score.time.beats}).
            </p>
          ))}
          {score.errors.map((err, i) => (
            <p key={`err-${i}`} className="flex items-center gap-1.5 text-xs text-port-error">
              <AlertTriangle size={12} className="shrink-0" /> {err}
            </p>
          ))}
        </div>
      )}

      {/* Collapsible format legend. */}
      {showLegend && (
        <dl className="mt-3 bg-port-card border border-port-border rounded-lg p-3 space-y-1.5">
          {LEGEND.map(([term, desc]) => (
            <div key={term} className="grid grid-cols-[5rem_1fr] gap-2">
              <dt className="text-xs font-semibold text-port-accent">{term}</dt>
              <dd className="text-xs text-gray-400">{desc}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
