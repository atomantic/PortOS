/**
 * ScoreSheet — renders PortOS lead-sheet notation as real sheet music, in SVG,
 * with no third-party engraving library (no abcjs / VexFlow / OSMD). It parses
 * the text with `scoreNotation.parseScore` and draws the staff, clef, key
 * signature, time signature, notes (heads / stems / flags / dots), accidentals,
 * ledger lines, rests, bar lines, chord symbols and lyrics from SVG primitives.
 *
 * Geometry is driven off one constant — the staff line gap. Every pitch is a
 * "diatonic step" (one line-or-space) from the clef's bottom-line reference, so
 * positioning a note is a single multiply. Measures pack into rows and each row
 * is justified to the page width; the clef + key signature redraw at the start
 * of every row (the time signature only on the first), matching engraving
 * convention.
 *
 * Ink follows the active PortOS theme (the `--port-text` / `--port-accent` CSS
 * variables) — near-black on a light day background, light on a dark one — so
 * the staff never washes out. The clef and accidental glyphs use Unicode music
 * characters (𝄞 𝄢 ♯ ♭ ♮) with a font stack — everything else is drawn, so a
 * missing music font degrades only the clef glyph, never the staff.
 */

import { useMemo, useState, useRef, useEffect, useId } from 'react';
import { parseScore } from '../../lib/scoreNotation.js';
import { createScorePlayer, DEFAULT_BPM } from '../../lib/scorePlayback.js';

// --- Geometry (all in internal SVG units; the <svg> scales via viewBox) ------
const WIDTH = 720;          // internal coordinate width — viewBox scales to fit
const MARGIN = 16;          // page padding inside the svg
const GAP = 12;             // distance between two adjacent staff lines
const STEP = GAP / 2;       // one diatonic step = half a line gap
const NOTE_RX = 6.2;        // notehead radii
const NOTE_RY = 4.6;
const STEM_LEN = GAP * 3;   // stem length (~3.5 lines reads well)
const FLAG_GAP = 8;         // vertical spacing between stacked flags

const CLEF_W = 36;
const KEYSIG_ACC_W = 9;     // width per key-signature accidental glyph
const TIME_W = 26;
const NOTE_LEAD = 18;       // space after a barline before the first note
const NOTE_TRAIL = 14;      // space after the last note before the barline
const MIN_SLOT = 24;        // minimum horizontal room a note occupies
const BEAT_PX = 30;         // horizontal px per quarter-note beat
const MAX_STRETCH = 1.45;   // cap row justification so a short row isn't blown out

const ROW_TOP_PAD = 34;     // room above the staff for chord symbols
const LYRIC_BELOW_NOTE = 14;   // gap from the lowest notehead down to the lyric baseline
const LYRIC_MIN_BELOW_STAFF = 22; // floor so a high-only row keeps lyrics close to the staff
const LYRIC_DESCENDER = 8;  // room below the lyric baseline for text descenders
const ROW_GAP = 18;         // gap between rows
// A row's height is derived from its content (see rowLyricOffset) rather than a
// fixed constant, so a row of low ledger notes reserves enough space for its
// lyrics instead of letting them spill into the next row.
const STAFF_BLOCK = 4 * GAP; // the five staff lines span four gaps

// Ink is driven off the PortOS theme text/accent CSS variables so the score
// adapts to the active theme — near-black notes & lyrics in day mode, light ink
// in dark mode — instead of a fixed light grey that washes out on a light
// background. var() only resolves in CSS context, so these are applied via the
// `style` prop (SVG presentation *attributes* don't evaluate var()), not as
// fill="…"/stroke="…" attributes. Staff lines sit at a dimmed muted tone so the
// noteheads (full text colour) read as the foreground in both themes.
const INK = 'rgb(var(--port-text))';
// The currently-sounding note (playhead) is painted in the theme accent so it
// reads as the foreground against the neutral-ink staff, in both day and dark.
const ACTIVE = 'rgb(var(--port-accent))';
// Color-match grade → notehead ink (theme tokens only). The grading lib
// (colorMatch.js) emits these level strings; the renderer stays pure by just
// mapping a passed grade to its color. Absent / `pending` grades fall through to
// the default ink so an un-sung note looks normal.
const GRADE_INK = {
  'in-tune': 'rgb(var(--port-success))',
  close: 'rgb(var(--port-warning))',
  off: 'rgb(var(--port-error))',
  missed: 'rgb(var(--port-error))',
};
const STAFF = 'rgb(var(--port-text-muted) / 0.55)';
const CHORD = 'rgb(var(--port-accent))';
const LYRIC = 'rgb(var(--port-text-muted))';
const MUSIC_FONT = "'Bravura','Noto Music','Segoe UI Symbol',ui-serif,serif";
// Small style helpers — colour goes through `style`, geometry stays attributes.
const strokeStyle = (color) => ({ stroke: color });
const fillStyle = (color) => ({ fill: color });

// Diatonic step that sits on the BOTTOM staff line, per clef. Treble bottom line
// is E4 (step 2); bass bottom line is G2 (step −10). Everything else is relative.
const BOTTOM_LINE_STEP = { treble: 2, bass: -10 };

// Unicode glyphs for the clef and accidentals (drawn as <text> — the only part
// that depends on a music-capable font; the staff itself is always drawn).
const CLEF_GLYPH = { treble: '\u{1D11E}', bass: '\u{1D122}' };
const ACCIDENTAL_GLYPH = { '#': '♯', '##': '\u{1D12A}', b: '♭', bb: '\u{1D12B}', n: '♮' };

// Key-signature accidental vertical positions (the diatonic step each glyph sits
// on), for the treble clef, in draw order. Bass shifts the whole cluster down two
// octaves (−14 steps) — a faithful-enough placement; bundled content is treble.
const TREBLE_SHARP_STEPS = { F: 10, C: 7, G: 11, D: 8, A: 5, E: 9, B: 6 };
const TREBLE_FLAT_STEPS = { B: 6, E: 9, A: 5, D: 8, G: 4, C: 7, F: 3 };

const slotFor = (note) => Math.max(MIN_SLOT, (note.duration?.beats || 1) * BEAT_PX);
const measureIntrinsic = (measure) => {
  if (!measure.notes.length) return NOTE_LEAD + MIN_SLOT + NOTE_TRAIL;
  return NOTE_LEAD + measure.notes.reduce((s, n) => s + slotFor(n), 0) + NOTE_TRAIL;
};

// Greedily pack measures into rows that fit the page width. Each row reserves a
// prefix for the clef + key signature (+ time signature on the first row).
const packRows = (measures, keySigCount) => {
  const contentRight = WIDTH - MARGIN;
  const rows = [];
  let i = 0;
  while (i < measures.length) {
    const firstRow = rows.length === 0;
    const prefix = CLEF_W + keySigCount * KEYSIG_ACC_W + (keySigCount ? 6 : 0) + (firstRow ? TIME_W : 0);
    const available = contentRight - MARGIN - prefix;
    const rowMeasures = [];
    let used = 0;
    while (i < measures.length) {
      const w = measureIntrinsic(measures[i]);
      if (rowMeasures.length > 0 && used + w > available) break;
      rowMeasures.push({ index: i, intrinsic: w, measure: measures[i] });
      used += w;
      i += 1;
    }
    // Justify: stretch the row to fill, but cap it so one short bar isn't
    // ballooned. A lone over-wide measure shrinks (stretch < 1) instead.
    const stretch = used > 0 ? Math.min(MAX_STRETCH, available / used) : 1;
    rows.push({ rowMeasures, prefix, firstRow, stretch });
  }
  return rows;
};

// Vertical room a row needs below the staff: from the staff's bottom line down
// to the lyric baseline, enough to clear the row's LOWEST notehead before the
// lyric sits under it. Floored at LYRIC_MIN_BELOW_STAFF so a row of only high
// notes still tucks its lyrics close under the staff. `bottomLineStep` is the
// diatonic step on the staff's bottom line. Single pass over the row's notes.
const rowLyricOffset = (row, bottomLineStep) => {
  let lowestStep = bottomLineStep;
  for (const rm of row.rowMeasures) {
    for (const note of rm.measure.notes) {
      if (!note.rest && note.step < lowestStep) lowestStep = note.step;
    }
  }
  const belowStaffPx = Math.max(0, bottomLineStep - lowestStep) * STEP; // staffBottom → lowest head
  return Math.max(LYRIC_MIN_BELOW_STAFF, belowStaffPx + LYRIC_BELOW_NOTE);
};

export default function ScoreSheet({ text, className = '', controls = true, activeNoteIndex = null, noteColors = null, hideLyrics = false }) {
  const score = useMemo(() => parseScore(text), [text]);

  // --- Reference-tone playback (synthesize the written melody) ---------------
  // The player lives in scorePlayback.js (pure schedule + a lookahead oscillator
  // scheduler); this component only owns the transport UI + the playhead index.
  // Hooks run unconditionally, before the no-music early return below.
  const uid = useId();
  const playerRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const scoreBpm = Number.isFinite(score.tempo) && score.tempo > 0 ? score.tempo : DEFAULT_BPM;
  const [tempo, setTempo] = useState(scoreBpm);

  // A changed score (live editing, switching songs) invalidates the player and
  // resets the transport; tempo re-syncs to the new score's marking.
  useEffect(() => {
    if (playerRef.current) { playerRef.current.stop(); playerRef.current = null; }
    setIsPlaying(false);
    setActiveIdx(-1);
    setTempo(scoreBpm);
  }, [score, scoreBpm]);

  // Tear down any live oscillators + lookahead interval on unmount.
  useEffect(() => () => {
    if (playerRef.current) { playerRef.current.stop(); playerRef.current = null; }
  }, []);

  // Tempo edits take effect on the running (or next) player.
  useEffect(() => { if (playerRef.current) playerRef.current.setTempo(tempo); }, [tempo]);

  const ensurePlayer = () => {
    if (!playerRef.current) {
      playerRef.current = createScorePlayer(score, {
        bpm: tempo,
        onNote: (i) => setActiveIdx(i == null ? -1 : i),
        onEnded: () => { setIsPlaying(false); setActiveIdx(-1); },
      });
    }
    return playerRef.current;
  };

  const togglePlay = () => {
    const player = ensurePlayer();
    if (isPlaying) { player.pause(); setIsPlaying(false); return; }
    setIsPlaying(true);
    Promise.resolve(player.play()).catch(() => setIsPlaying(false));
  };

  const handleStop = () => {
    if (playerRef.current) playerRef.current.stop();
    setIsPlaying(false);
    setActiveIdx(-1);
  };

  // A passed `activeNoteIndex` (controlled use / tests) wins over internal play.
  const highlight = activeNoteIndex == null ? activeIdx : activeNoteIndex;

  const { rows, height } = useMemo(() => {
    const packed = packRows(score.measures, score.keySig.count);
    const blStep = BOTTOM_LINE_STEP[score.clef] ?? BOTTOM_LINE_STEP.treble;
    // Lay rows out with content-derived heights and cumulative tops, so a row of
    // low notes reserves more vertical space and never overlaps the next row.
    let top = 0;
    const laid = packed.map((row) => {
      const lyricOffset = rowLyricOffset(row, blStep);
      const rowHeight = ROW_TOP_PAD + STAFF_BLOCK + lyricOffset + LYRIC_DESCENDER + ROW_GAP;
      const annotated = { ...row, top, lyricOffset };
      top += rowHeight;
      return annotated;
    });
    return { rows: laid, height: top + 8 };
  }, [score]);

  if (!score.measures.some((m) => m.notes.length > 0)) return null;

  const bottomLineStep = BOTTOM_LINE_STEP[score.clef] ?? BOTTOM_LINE_STEP.treble;
  const middleLineStep = bottomLineStep + 4;

  const els = [];
  // Global note index across the whole score, in the same order scorePlayback's
  // buildSchedule walks it — so `highlight` (the now-sounding note) lines up with
  // the correct notehead for the playhead.
  let noteCounter = 0;
  rows.forEach((row, ri) => {
    const rowTop = row.top;
    const staffTop = rowTop + ROW_TOP_PAD;
    const staffBottom = staffTop + STAFF_BLOCK;
    const chordY = rowTop + 16;
    // y for a diatonic step within this row.
    const yForStep = (step) => staffBottom - (step - bottomLineStep) * STEP;
    // Lyric baseline sits below the row's lowest notehead (row.lyricOffset is the
    // content-derived gap), so below-staff ledger notes (e.g. A3) never draw on
    // top of the lyric text and the row height already reserves the space.
    const lyricY = staffBottom + row.lyricOffset;

    // Staff: five lines across the full content width.
    for (let line = 0; line < 5; line += 1) {
      const y = staffTop + line * GAP;
      els.push(<line key={`s${ri}-${line}`} x1={MARGIN} y1={y} x2={WIDTH - MARGIN} y2={y} style={strokeStyle(STAFF)} strokeWidth={1} />);
    }

    let x = MARGIN;
    // Clef glyph — vertically anchored so its centre sits on the staff.
    els.push(
      <text key={`clef${ri}`} x={x + 2} y={score.clef === 'bass' ? staffTop + GAP * 1.6 : staffBottom + GAP * 0.5}
        fontSize={score.clef === 'bass' ? 40 : 56} style={fillStyle(INK)} fontFamily={MUSIC_FONT} dominantBaseline="alphabetic">
        {CLEF_GLYPH[score.clef] || CLEF_GLYPH.treble}
      </text>,
    );
    x += CLEF_W;

    // Key signature — the accidental cluster, redrawn every row.
    if (score.keySig.count) {
      const glyph = score.keySig.type === 'sharp' ? ACCIDENTAL_GLYPH['#'] : ACCIDENTAL_GLYPH.b;
      const stepTable = score.keySig.type === 'sharp' ? TREBLE_SHARP_STEPS : TREBLE_FLAT_STEPS;
      const shift = score.clef === 'bass' ? -14 : 0;
      score.keySig.letters.forEach((letter, ki) => {
        const step = (stepTable[letter] ?? middleLineStep) + shift;
        els.push(
          <text key={`ks${ri}-${ki}`} x={x + ki * KEYSIG_ACC_W} y={yForStep(step) + 5}
            fontSize={18} style={fillStyle(INK)} fontFamily={MUSIC_FONT} textAnchor="middle">{glyph}</text>,
        );
      });
      x += score.keySig.count * KEYSIG_ACC_W + 6;
    }

    // Time signature — first row only (engraving convention).
    if (row.firstRow) {
      els.push(
        <text key={`tb${ri}`} x={x + TIME_W / 2} y={staffTop + GAP * 1.1} fontSize={17} fontWeight="700"
          style={fillStyle(INK)} textAnchor="middle" fontFamily="ui-serif, serif">{score.time.beats}</text>,
        <text key={`tv${ri}`} x={x + TIME_W / 2} y={staffTop + GAP * 3.1} fontSize={17} fontWeight="700"
          style={fillStyle(INK)} textAnchor="middle" fontFamily="ui-serif, serif">{score.time.beatValue}</text>,
      );
      x += TIME_W;
    }

    // Opening barline at the start of the measures.
    els.push(<line key={`bl-open${ri}`} x1={x} y1={staffTop} x2={x} y2={staffBottom} style={strokeStyle(STAFF)} strokeWidth={1} />);

    // Measures.
    row.rowMeasures.forEach(({ measure, index }) => {
      const measureWidth = measureIntrinsic(measure) * row.stretch;
      let cursor = x + NOTE_LEAD * row.stretch;
      measure.notes.forEach((note, ni) => {
        const slot = slotFor(note) * row.stretch;
        const cx = cursor + slot / 2;
        cursor += slot;
        const key = `m${index}-n${ni}`;
        // Ink precedence: the live playhead (accent) wins on the active note;
        // otherwise a color-match grade (green/yellow/red) paints the head; else
        // default ink. `noteColors` is keyed by the same global note index.
        const grade = noteColors?.[noteCounter];
        const ink = noteCounter === highlight
          ? ACTIVE
          : (GRADE_INK[grade] || INK);
        noteCounter += 1;
        if (note.rest) {
          els.push(...renderRest(note, cx, yForStep, bottomLineStep, key, ink));
        } else {
          els.push(...renderNote(note, cx, yForStep, bottomLineStep, middleLineStep, key, ink));
        }
        if (note.chord) {
          els.push(<text key={`${key}-ch`} x={cx} y={chordY} fontSize={12} fontWeight="600" style={fillStyle(CHORD)} textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif">{note.chord}</text>);
        }
        // `hideLyrics` lets training mode obscure the words (sing from memory)
        // without stripping them from the score text the editor still owns.
        if (note.lyric && !hideLyrics) {
          els.push(<text key={`${key}-ly`} x={cx} y={lyricY} fontSize={11} style={fillStyle(LYRIC)} textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif">{note.lyric}</text>);
        }
      });
      x += measureWidth;
      els.push(<line key={`bl${index}`} x1={x} y1={staffTop} x2={x} y2={staffBottom} style={strokeStyle(STAFF)} strokeWidth={1} />);
    });
  });

  return (
    <div className="w-full">
      {controls && (
        <div className="flex flex-wrap items-center gap-2 mb-2 text-xs text-gray-400">
          <button
            type="button"
            onClick={togglePlay}
            aria-label={isPlaying ? 'Pause melody' : 'Play melody'}
            className="flex items-center gap-1 rounded-md border border-port-border bg-port-card px-2 py-1 text-white hover:border-port-accent transition-colors"
          >
            <span aria-hidden="true">{isPlaying ? '⏸' : '▶'}</span>
            <span className="hidden sm:inline">{isPlaying ? 'Pause' : 'Play melody'}</span>
          </button>
          <button
            type="button"
            onClick={handleStop}
            aria-label="Stop melody"
            disabled={!isPlaying && activeIdx < 0}
            className="flex items-center gap-1 rounded-md border border-port-border bg-port-card px-2 py-1 text-white hover:border-port-accent transition-colors disabled:opacity-40 disabled:hover:border-port-border"
          >
            <span aria-hidden="true">⏹</span>
            <span className="hidden sm:inline">Stop</span>
          </button>
          <label htmlFor={`${uid}-tempo`} className="ml-auto flex items-center gap-1">
            <span>Tempo</span>
            <input
              id={`${uid}-tempo`}
              type="number"
              min={20}
              max={300}
              value={tempo}
              onChange={(e) => {
                const next = Number(e.target.value);
                if (Number.isFinite(next) && next > 0) setTempo(next);
              }}
              className="w-16 rounded-md border border-port-border bg-port-card px-2 py-1 text-white"
            />
            <span>BPM</span>
          </label>
        </div>
      )}
      <svg
        className={className}
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        role="img"
        aria-label="Sheet music notation"
        style={{ height: 'auto', display: 'block' }}
      >
        {els}
      </svg>
    </div>
  );
}

// --- Per-note drawing -------------------------------------------------------
function renderNote(note, cx, yForStep, bottomLineStep, middleLineStep, key, ink = INK) {
  const out = [];
  const step = note.step;
  const y = yForStep(step);
  const up = step < middleLineStep; // notes below the middle line stem up
  const filled = note.duration.filled;

  // Ledger lines — short segments at each staff-line position the note reaches
  // beyond the five lines. Lines sit on even offsets from the bottom line.
  const topStep = bottomLineStep + 8;
  if (step > topStep) {
    for (let s = topStep + 2; s <= step; s += 2) {
      const ly = yForStep(s);
      out.push(<line key={`${key}-lg${s}`} x1={cx - NOTE_RX - 3} y1={ly} x2={cx + NOTE_RX + 3} y2={ly} style={strokeStyle(STAFF)} strokeWidth={1} />);
    }
  } else if (step < bottomLineStep) {
    for (let s = bottomLineStep - 2; s >= step; s -= 2) {
      const ly = yForStep(s);
      out.push(<line key={`${key}-lg${s}`} x1={cx - NOTE_RX - 3} y1={ly} x2={cx + NOTE_RX + 3} y2={ly} style={strokeStyle(STAFF)} strokeWidth={1} />);
    }
  }

  // Accidental glyph, left of the head.
  if (note.pitch.accidental && ACCIDENTAL_GLYPH[note.pitch.accidental]) {
    out.push(<text key={`${key}-acc`} x={cx - NOTE_RX - 6} y={y + 5} fontSize={16} style={fillStyle(ink)} textAnchor="middle" fontFamily={MUSIC_FONT}>{ACCIDENTAL_GLYPH[note.pitch.accidental]}</text>);
  }

  // Notehead — open for half/whole, solid otherwise. A slight rotation gives
  // the classic oval slant.
  out.push(
    <ellipse key={`${key}-head`} cx={cx} cy={y} rx={NOTE_RX} ry={NOTE_RY}
      transform={`rotate(-18 ${cx} ${y})`}
      style={{ fill: filled ? ink : "none", stroke: ink }} strokeWidth={filled ? 0 : 1.4} />,
  );

  // Stem + flags (whole notes have neither).
  if (note.duration.stem) {
    const stemX = up ? cx + NOTE_RX - 0.6 : cx - NOTE_RX + 0.6;
    const stemEndY = up ? y - STEM_LEN : y + STEM_LEN;
    out.push(<line key={`${key}-stem`} x1={stemX} y1={y} x2={stemX} y2={stemEndY} style={strokeStyle(ink)} strokeWidth={1.3} />);
    for (let f = 0; f < note.duration.flags; f += 1) {
      const fy = up ? stemEndY + f * FLAG_GAP : stemEndY - f * FLAG_GAP;
      const dir = up ? 1 : -1;
      out.push(
        <path key={`${key}-flag${f}`}
          d={`M ${stemX} ${fy} Q ${stemX + 11} ${fy + dir * 5} ${stemX + 8} ${fy + dir * 16}`}
          style={{ fill: "none", stroke: ink }} strokeWidth={1.6} strokeLinecap="round" />,
      );
    }
  }

  // Augmentation dot(s), to the right of the head — nudged into the space if the
  // note sits on a line.
  if (note.duration.dots) {
    const onLine = ((step - bottomLineStep) % 2 + 2) % 2 === 0;
    const dy = onLine ? y - STEP : y;
    for (let d = 0; d < note.duration.dots; d += 1) {
      out.push(<circle key={`${key}-dot${d}`} cx={cx + NOTE_RX + 4 + d * 4} cy={dy} r={1.5} style={fillStyle(ink)} />);
    }
  }
  return out;
}

// --- Per-rest drawing -------------------------------------------------------
// Rests are drawn from primitives (not Unicode) so they render identically on
// every platform. Positions are relative to the middle staff line.
function renderRest(note, cx, yForStep, bottomLineStep, key, ink = INK) {
  const code = note.duration.code;
  const midLine = yForStep(bottomLineStep + 4);
  const secondTop = yForStep(bottomLineStep + 6); // 2nd line from top (whole rest hangs here)
  const out = [];
  if (code === 'w') {
    out.push(<rect key={`${key}-r`} x={cx - 5} y={secondTop} width={10} height={GAP * 0.4} style={fillStyle(ink)} />);
  } else if (code === 'h') {
    out.push(<rect key={`${key}-r`} x={cx - 5} y={midLine - GAP * 0.4} width={10} height={GAP * 0.4} style={fillStyle(ink)} />);
  } else if (code === 'q') {
    // Stylized quarter rest — a zig-zag down the middle of the staff.
    const top = yForStep(bottomLineStep + 6);
    out.push(
      <path key={`${key}-r`}
        d={`M ${cx - 3} ${top} L ${cx + 3} ${top + GAP} L ${cx - 2.5} ${top + GAP * 1.7} Q ${cx + 4} ${top + GAP * 2.2} ${cx + 1} ${top + GAP * 3}`}
        style={{ fill: "none", stroke: ink }} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />,
    );
  } else {
    // Eighth / sixteenth / 32nd rest — a diagonal stroke with one blob per flag.
    const top = yForStep(bottomLineStep + 5);
    out.push(<line key={`${key}-rstroke`} x1={cx + 3} y1={top} x2={cx - 3} y2={top + GAP * 2} style={strokeStyle(ink)} strokeWidth={1.4} />);
    for (let f = 0; f < (note.duration.flags || 1); f += 1) {
      out.push(<circle key={`${key}-rb${f}`} cx={cx + 2} cy={top + f * GAP * 0.9} r={2} style={fillStyle(ink)} />);
    }
  }
  return out;
}
