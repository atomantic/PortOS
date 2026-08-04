/**
 * DrumSheetView — renders PortOS drum-kit notation (drumNotation.js) as ONE
 * continuous horizontal kit strip in hand-rolled SVG, with no engraving library
 * (the same explicit choice `ScoreSheet.jsx` makes: no VexFlow / abcjs / OSMD).
 *
 * A phone is the primary SongBook surface, and a drummer reads a groove the way
 * it is played: left to right, without end. So the whole song is a single lane
 * that scrolls horizontally under a playhead, rather than a stack of per-bar
 * grids that push the kit off the bottom of a phone screen (the pre-#3115
 * layout put ~1.5 bars above the fold on a 390px viewport). The kit labels live
 * in their own frozen column beside the scroller so "which row is the snare"
 * survives scrolling to bar 30.
 *
 * Geometry is driven off ONE constant — the grid cell size — in fixed internal
 * SVG units; the viewer's A−/A+ control scales the whole strip through the
 * `fontSizeRem` prop instead of recomputing any of it.
 *
 * THE PLAYHEAD NEVER GOES THROUGH REACT. `getPlayhead()` (useDrumPlayer) reads
 * the audio clock, and one animation-frame loop writes the results straight to
 * the DOM: a column rect on the current step, a line at the exact sub-step
 * position, and the scroller's `scrollLeft`. So a 16th-note groove repaints two
 * attributes per frame instead of re-rendering a ~2000-element SVG 8×/second.
 * The clock is also the only source that keeps moving through a rest — the
 * player's `onStep` events stall there (see `resolvePlayhead`).
 *
 * Ink comes from the PortOS theme CSS variables (`--port-text` / `--port-accent`
 * / `--port-text-muted`) applied through the `style` prop — SVG presentation
 * *attributes* don't evaluate `var()`, so `fill="var(--x)"` would silently paint
 * nothing. Same rule as ScoreSheet.
 *
 * TAP A NOTE TO LEARN IT. This notation is hand-rolled, so nothing outside this
 * repo explains what an × with a chevron over it is asking for. Tapping a glyph
 * opens a readout (`describeDrumCell` in drumNotation.js) naming the piece, the
 * articulation, and how to strike it; the Legend button is the same content
 * for the whole kit, and the lane is focusable so ←/→ walk the hits without a
 * pointer. Hit-testing is arithmetic on the click coordinates rather than a
 * per-cell <rect>, because a 32-bar chart would otherwise carry ~2500 invisible
 * tap targets purely so a tap could report where it landed.
 *
 * Props:
 *   text        — the raw chart source (parsed here; the parser never throws)
 *   fontSizeRem — scales the whole strip with the viewer's A−/A+ control
 *   getPlayhead — `() => { countIn, bar, stepFloat } | null`; absent → a static
 *                 sheet with no playhead and no auto-follow
 *   playing     — gates the animation frame loop
 *   onStepClick — optional `(barIndex, step, pieceId)` for a future tap-a-cell
 *                 editor (#3115 out-of-scope); adds a rect per cell
 *   explain     — tap/arrow-key note explanation + Legend button (default on).
 *                 Independent of `onStepClick`: an editor host is where "what
 *                 does this glyph mean" matters most, so it can keep both and
 *                 have a tap toggle the cell AND explain it
 */

import { memo, useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseDrumChart, kitPiece, describeDrumCell, describeDrumPosition, drumGlyphLegend } from '../../lib/drumNotation.js';
import useEscapeKey from '../../hooks/useEscapeKey.js';
import { ctrlBtnClass, activeCtrlClass } from './constants.js';

// --- Geometry (internal SVG units; the strip scales via width/height + viewBox)
const CELL = 20;              // one grid step — every other measure derives from this
const ROW_H = CELL;           // one kit-piece row
const LABEL_W = 56;           // the frozen label column ("Hi-Hat", "Floor Tom")
const PAD = 6;                // padding inside the svgs
const HEAD_R = CELL * 0.3;    // notehead radius
const GHOST_R = CELL * 0.2;
const CROSS_R = CELL * 0.26;
const HEADER_H = 20;          // bar-number / section-label strip above the grid
const BAR_GAP = 6;            // breathing room between bars, inside the lane

const GRID_TOP = PAD + HEADER_H;
// Vertical centre of kit row `ri` — shared by the lane and the frozen label
// column, which have to stay in lockstep or the labels drift off their rows.
const rowCenterY = (ri) => GRID_TOP + ri * ROW_H + ROW_H / 2;

// The lane geometry a tap has to be aimed at, exported so the tests target the
// real values instead of mirroring (and silently outliving) them: a stale copy
// of GRID_TOP in a test would keep agreeing with a stale inverse in
// `selectFromPoint` while every tap in the app reported the wrong note.
export const SHEET_GEOMETRY = { CELL, ROW_H, PAD, HEADER_H, GRID_TOP, BAR_GAP };

// Zoom: the A−/A+ font control drives the whole strip. 0.875rem is the viewer's
// default, so that maps to 1×.
const BASE_FONT_REM = 0.875;
const SCALE_MIN = 0.7;
const SCALE_MAX = 2.4;

// Where the playhead sits in the viewport while the sheet scrolls under it —
// far enough left that the bar you're about to play is the one you can read.
const FOLLOW_FRACTION = 0.35;

// Ink — theme CSS vars, applied via `style` (see the header note). Hoisted as
// shared objects, not built per element: the lane is ~2000 nodes on a long
// chart, and a fresh `{ fill }` literal each also defeats React's diff.
const INK = { fill: 'rgb(var(--port-text))' };
const INK_STROKE = { stroke: 'rgb(var(--port-text))' };
const INK_HOLLOW = { fill: 'none', stroke: 'rgb(var(--port-text))' };
const GRID = { stroke: 'rgb(var(--port-text-muted) / 0.35)' };
const GRID_BEAT = { stroke: 'rgb(var(--port-text-muted) / 0.7)' };
const LABEL = { fill: 'rgb(var(--port-text-muted))' };
const ACTIVE_STROKE = { stroke: 'rgb(var(--port-accent))' };
const ACTIVE_FILL = { fill: 'rgb(var(--port-accent) / 0.18)' };
const SELECT_BOX = { stroke: 'rgb(var(--port-accent))', fill: 'rgb(var(--port-accent) / 0.14)' };
const UI_FONT = 'ui-sans-serif, system-ui, sans-serif';

// Time-signature denominator → the note glyph for one BEAT at that value, for the
// tempo marking. The tempo counts notated beats, so 6/8 must read "♪ = 96", not
// "♩ = 96" — an unlisted denominator falls back to a plain "1/N" fraction rather
// than a wrong glyph.
const BEAT_GLYPH = { 1: '𝅝', 2: '𝅗𝅥', 4: '♩', 8: '♪', 16: '𝅘𝅥𝅯' };

// One hit's glyph, pushed into the caller's element array. `cross` pieces
// (cymbals, hats) draw an ×; `head` pieces (drums) draw a notehead. The cell's
// own flags then modify it: a ring for an open hi-hat, a small hollow head for a
// ghost, a leading grace head for a flam, and a chevron above an accent.
const pushHit = (out, cell, piece, cx, cy, key) => {
  const cross = kitPiece(piece)?.glyph === 'cross';

  if (cell.flam) {
    // Grace note just ahead of the beat — small and offset left.
    const gx = cx - CELL * 0.3;
    out.push(cross
      ? <line key={`${key}-fl1`} x1={gx - GHOST_R} y1={cy - GHOST_R} x2={gx + GHOST_R} y2={cy + GHOST_R} style={INK_STROKE} strokeWidth={1.1} />
      : <circle key={`${key}-fl1`} cx={gx} cy={cy} r={GHOST_R} style={INK_HOLLOW} strokeWidth={1.1} />);
    if (cross) {
      out.push(<line key={`${key}-fl2`} x1={gx - GHOST_R} y1={cy + GHOST_R} x2={gx + GHOST_R} y2={cy - GHOST_R} style={INK_STROKE} strokeWidth={1.1} />);
    }
  }

  if (cross) {
    const r = cell.ghost ? GHOST_R : CROSS_R;
    const w = cell.accent ? 2.2 : 1.6;
    out.push(
      <line key={`${key}-a`} x1={cx - r} y1={cy - r} x2={cx + r} y2={cy + r} style={INK_STROKE} strokeWidth={w} strokeLinecap="round" />,
      <line key={`${key}-b`} x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} style={INK_STROKE} strokeWidth={w} strokeLinecap="round" />,
    );
    // Open hi-hat: the conventional circle around the ×.
    if (cell.open) {
      out.push(<circle key={`${key}-o`} cx={cx} cy={cy} r={r + 2.6} style={INK_HOLLOW} strokeWidth={1.2} />);
    }
  } else if (cell.ghost) {
    // Ghost note — the parenthesized/hollow head convention.
    out.push(<circle key={`${key}-h`} cx={cx} cy={cy} r={GHOST_R} style={INK_HOLLOW} strokeWidth={1.2} />);
  } else {
    out.push(<circle key={`${key}-h`} cx={cx} cy={cy} r={HEAD_R} style={INK} />);
  }

  if (cell.accent) {
    // Accent chevron above the head (the > articulation mark, rotated to sit
    // horizontally over the note). Kept inside the row: at much more than 0.36
    // of a cell up, the chevron crosses the lane line into the row above.
    const y = cy - CELL * 0.36;
    out.push(
      <path key={`${key}-ac`}
        d={`M ${cx - HEAD_R - 1} ${y - 2.4} L ${cx + HEAD_R + 1} ${y} L ${cx - HEAD_R - 1} ${y + 2.4}`}
        style={INK_HOLLOW} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />,
    );
  }
};

// The frozen kit-piece labels beside the scroller. Its own <svg> so it can't
// scroll away, sharing the lane's row geometry exactly.
const LabelColumn = ({ pieces, height, scale }) => (
  <svg
    viewBox={`0 0 ${LABEL_W} ${height}`}
    width={LABEL_W * scale}
    height={height * scale}
    aria-hidden="true"
    className="shrink-0"
    style={{ display: 'block' }}
  >
    {pieces.map((id, ri) => (
      <text key={id} x={LABEL_W - 5} y={rowCenterY(ri) + 3.5} fontSize={9.5} textAnchor="end" style={LABEL} fontFamily={UI_FONT}>
        {kitPiece(id)?.label || id}
      </text>
    ))}
  </svg>
);

// What the tapped glyph means. Sits UNDER the strip rather than floating beside
// the note: the lane is a horizontal scroller that auto-follows the playhead, so
// an anchored bubble would slide off its own note mid-groove — the in-lane
// highlight box says WHICH note, and this card says what it is. `aria-live` so a
// keyboard walk through the hits is announced as the selection moves.
const HitReadout = ({ info, position, onClose }) => (
  <div
    role="status"
    aria-live="polite"
    className="mt-2 rounded-lg border border-port-accent/40 bg-port-accent/5 px-3 py-2 text-xs"
  >
    <div className="flex items-start gap-2">
      <span
        aria-hidden="true"
        className="shrink-0 rounded border border-port-border bg-port-bg px-1.5 py-0.5 font-mono text-sm text-port-accent"
      >
        {info.char}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="font-semibold text-white">{info.pieceLabel} — {info.articulation}</span>
          <span className="text-gray-500">{position}</span>
          {!info.rest && <span className="text-gray-500">≈{info.velocityPercent}% volume</span>}
        </div>
        <p className="mt-1 text-gray-300">{info.detail}</p>
        {info.technique && <p className="mt-0.5 text-gray-400">{info.technique}</p>}
      </div>
      {/* A text × rather than a lucide icon: an `<svg>` anywhere in this
          component inflates the glyph counts that assert what the NOTATION drew
          (see DrumSheetView.test.jsx `count(html, 'circle')`). */}
      <button
        type="button"
        onClick={onClose}
        aria-label="Close note explanation"
        className="shrink-0 rounded px-1.5 leading-none text-base text-gray-500 hover:text-gray-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-port-accent min-h-[44px] min-w-[44px] flex items-center justify-center"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  </div>
);

// The whole vocabulary at once — every cell character, plus how to strike each
// piece THIS chart uses. The keyboard/screen-reader route to the same content
// the tap readout gives, and the answer to "what are my options" when writing a
// chart in Edit mode.
const KitLegend = ({ id, pieces }) => (
  <div id={id} className="mt-2 rounded-lg border border-port-border bg-port-bg/60 px-3 py-2 text-xs">
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
      {drumGlyphLegend(pieces).map((glyph) => (
        <div key={glyph.char} className="flex items-start gap-2">
          <dt className="shrink-0 rounded border border-port-border bg-port-card px-1.5 font-mono text-sm text-port-accent">
            {glyph.char}
          </dt>
          <dd className="min-w-0 text-gray-300">
            <span className="font-semibold text-white">{glyph.name}</span> — {glyph.detail}
          </dd>
        </div>
      ))}
    </dl>
    <dl className="mt-2 space-y-1 border-t border-port-border pt-2">
      {pieces.map(kitPiece).map((piece) => (
        <div key={piece.id} className="flex items-start gap-2">
          <dt className="w-20 shrink-0 font-semibold text-white">{piece.label}</dt>
          <dd className="min-w-0 text-gray-400">{piece.technique}</dd>
        </div>
      ))}
    </dl>
  </div>
);

// Chart problems (unknown pieces, over-long rows, bad headers). Rendered
// ALONGSIDE the sheet, never instead of it — a chart with one bad row must still
// draw the bars that parsed.
const ErrorSummary = ({ errors }) => (
  <div className="mt-3 rounded-lg border border-port-warning/40 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
    <div className="font-semibold mb-1">
      {errors.length} chart note{errors.length === 1 ? '' : 's'}
    </div>
    <ul className="list-disc pl-4 space-y-0.5">
      {errors.map((err, i) => <li key={i}>{err}</li>)}
    </ul>
  </div>
);

function DrumSheetView({
  text,
  fontSizeRem = 0.875,
  getPlayhead,
  playing = false,
  onStepClick,
  explain = true,
  className = '',
}) {
  const chart = useMemo(() => parseDrumChart(text), [text]);
  const scrollRef = useRef(null);
  const laneRef = useRef(null);
  const lineRef = useRef(null);
  const columnRef = useRef(null);
  // The selection the reveal effect has already scrolled to (see that effect).
  const revealedRef = useRef(null);
  // The note whose explanation is showing — `{ bar, step, piece }` or null.
  const [selection, setSelection] = useState(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const legendId = useId();

  const scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, (fontSizeRem || BASE_FONT_REM) / BASE_FONT_REM));
  const { pieces, subdivision, stepsPerBar } = chart;
  const gridBottom = GRID_TOP + pieces.length * ROW_H;
  const height = gridBottom + PAD;

  // Every bar is exactly `stepsPerBar` wide (the parser pads every row to that
  // length), so a bar's lane position is arithmetic — no per-bar measuring.
  // Memoized as one object so the rAF loop can depend on the whole geometry.
  const { barCount, barW, barX, laneW } = useMemo(() => {
    const w = chart.stepsPerBar * CELL;
    const x = (barIndex) => PAD + (barIndex - 1) * (w + BAR_GAP);
    return {
      barCount: chart.bars.length,
      barW: w,
      barX: x,
      laneW: Math.max(PAD * 2, x(chart.bars.length + 1) - BAR_GAP + PAD),
    };
  }, [chart]);

  // "Which cells does row `piece` of bar `bar` hold" — ONE lookup table for the
  // three consumers that ask (the glyph pass, the tap hit-test, and the arrow
  // walk), so "what counts as a struck cell" can't be answered two ways.
  const { cellsFor, hits } = useMemo(() => {
    const rows = new Map();
    const struck = [];
    for (const bar of chart.bars) {
      for (const row of bar.rows) rows.set(`${bar.index}:${row.piece}`, row.cells);
      // Resolved once per bar, not per cell. Reading order — time, then top of
      // the kit down — so ←/→ walk the groove the way it's played and reach
      // exactly the notes a tap can.
      const barRows = chart.pieces.map((piece) => rows.get(`${bar.index}:${piece}`));
      for (let step = 0; step < chart.stepsPerBar; step += 1) {
        barRows.forEach((cells, ri) => {
          if (cells && !cells[step].rest) struck.push({ bar: bar.index, step, piece: chart.pieces[ri] });
        });
      }
    }
    return { cellsFor: (bar, piece) => rows.get(`${bar}:${piece}`), hits: struck };
  }, [chart]);

  // --- Tap / arrow-key note explanation --------------------------------------

  // Click coordinates → the note the finger meant. The tapped cell first, then
  // one step either side in the SAME row: a cell is 20px wide at 1× zoom, well
  // under a fingertip, so a near-miss on a groove should still answer rather
  // than dismiss. A tap that lands on no hit at all closes the readout, which is
  // the natural "tap the background to dismiss" gesture.
  const selectFromPoint = (clientX, clientY) => {
    const box = laneRef.current.getBoundingClientRect();
    // Into internal SVG units: the lane is drawn `laneW × height` and displayed
    // at `scale` times that, with no other transform in between.
    const ux = (clientX - box.left) / scale;
    const uy = (clientY - box.top) / scale;
    const piece = pieces[Math.floor((uy - GRID_TOP) / ROW_H)];
    const span = barW + BAR_GAP;
    const rel = ux - PAD;
    const bar = Math.floor(rel / span) + 1;
    const within = rel - (bar - 1) * span;
    // `uy < GRID_TOP` floors negative → no piece; `within >= barW` is the gap
    // between bars. Either way there's nothing under the finger.
    if (!piece || bar < 1 || bar > barCount || within < 0 || within >= barW) { setSelection(null); return; }
    const cells = cellsFor(bar, piece);
    const step = Math.floor(within / CELL);
    const found = [step, step - 1, step + 1]
      .find((s) => s >= 0 && s < stepsPerBar && cells && !cells[s].rest);
    // `found` can legitimately be step 0, so test for the miss explicitly.
    setSelection(found === undefined ? null : { bar, step: found, piece });
  };

  // ←/→ (and ↑/↓, since reading order usually means the next row down) walk the
  // hits. From no selection, → starts at the first note and ← at the last.
  const onLaneKeyDown = (e) => {
    const delta = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1
      : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
    if (!delta || !hits.length) return;
    e.preventDefault();   // arrows would otherwise scroll the lane out from under the walk
    setSelection((prev) => {
      const i = prev
        ? hits.findIndex((h) => h.bar === prev.bar && h.step === prev.step && h.piece === prev.piece)
        : -1;
      if (i < 0) return hits[delta > 0 ? 0 : hits.length - 1];
      return hits[Math.min(hits.length - 1, Math.max(0, i + delta))];
    });
  };

  useEscapeKey(!!selection, () => setSelection(null));

  // Bring a newly selected note into view — for the arrow walk, which is the only
  // path that can select something off screen (a tap's note is under the finger,
  // so both branches below are no-ops for it).
  //
  // Keyed on the SELECTION IDENTITY, not just the effect firing: `playing` is a
  // dep (the rAF follow loop owns `scrollLeft` while it runs, so this must stand
  // down), and without the identity check, merely STOPPING playback would re-run
  // this and yank the strip back to a selection made long before — away from where
  // the playhead just stopped.
  useEffect(() => {
    const el = scrollRef.current;
    if (selection === revealedRef.current) return;
    revealedRef.current = selection;
    if (!selection || !el || playing) return;
    const left = (barX(selection.bar) + selection.step * CELL) * scale;
    const right = left + CELL * scale;
    // Land one cell inside the edge so the next note along is visible too.
    if (left < el.scrollLeft) el.scrollLeft = Math.max(0, left - CELL * scale);
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth + CELL * scale;
  }, [selection, playing, barX, scale]);

  // One rAF loop for both playhead marks and the auto-follow scroll. All DOM
  // READS happen before any write — reading scrollLeft/clientWidth after
  // dirtying the tree in the same frame forces a synchronous layout.
  useEffect(() => {
    const line = lineRef.current;
    const column = columnRef.current;
    if (!line || !column) return undefined;
    const hide = () => {
      line.style.display = 'none';
      column.style.display = 'none';
    };
    if (!playing || !getPlayhead || typeof requestAnimationFrame !== 'function') {
      hide();
      return undefined;
    }
    let raf = requestAnimationFrame(function tick() {
      raf = requestAnimationFrame(tick);
      const pos = getPlayhead();
      // The count-in has no position on the sheet — park the marks rather than
      // sliding them through bar 1 before bar 1 is playing.
      if (!pos || pos.countIn || pos.bar > barCount) { hide(); return; }

      const el = scrollRef.current;
      const viewportW = el?.clientWidth ?? 0;
      const x = barX(pos.bar) + pos.stepFloat * CELL;

      line.style.display = '';
      column.style.display = '';
      line.setAttribute('transform', `translate(${x} 0)`);
      column.setAttribute('x', barX(pos.bar) + Math.floor(pos.stepFloat) * CELL);

      if (!el) return;
      const max = laneW * scale - viewportW;
      if (max <= 0) return;
      el.scrollLeft = Math.min(max, Math.max(0, x * scale - viewportW * FOLLOW_FRACTION));
    });
    return () => { cancelAnimationFrame(raf); hide(); };
  }, [playing, getPlayhead, barCount, barX, laneW, scale]);

  // A new chart starts from the top, with no note selected — the old selection
  // pointed at a bar/step that may not exist any more (live editing). Content-
  // keyed, so a host that can show two DIFFERENT records with identical charts
  // in one mounted sheet should key this component by record id
  // (SongBookViewer does).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
    setSelection(null);
  }, [chart]);

  // The lane's grid + glyphs — ~2000 elements on a long chart, memoized on the
  // chart and its geometry ALONE. Selecting a note re-renders this component (the
  // readout is React state), and returning one stable <g> ELEMENT (not just a
  // stable array, which still costs a fiber visit per child) lets React bail out
  // at that single node. The selection box is drawn outside it.
  const lane = useMemo(() => {
    const out = [];
    let lastLabel = null;

    chart.bars.forEach((bar) => {
      const x = barX(bar.index);

      // Bar number, always; the section label only where it CHANGES. A four-bar
      // block repeating its own name over every bar is noise on a phone.
      out.push(
        <text key={`n${bar.index}`} x={x + 1} y={GRID_TOP - 8} fontSize={9} fontWeight="600" style={LABEL} fontFamily={UI_FONT}>
          {bar.index}
        </text>,
      );
      if (bar.label && bar.label !== lastLabel) {
        out.push(
          <text key={`l${bar.index}`} x={x + 14} y={GRID_TOP - 8} fontSize={9.5} style={LABEL} fontFamily={UI_FONT}>
            {bar.label}{bar.repeat > 1 ? ` ×${bar.repeat}` : ''}
          </text>,
        );
      }
      lastLabel = bar.label;

      // Lane lines for this bar's span (one per kit row, plus the bottom edge).
      for (let ri = 0; ri <= pieces.length; ri += 1) {
        const y = GRID_TOP + ri * ROW_H;
        out.push(<line key={`h${bar.index}-${ri}`} x1={x} y1={y} x2={x + barW} y2={y} style={GRID} strokeWidth={1} />);
      }

      // Vertical step lines — every `subdivision`-th is a beat boundary (heavier),
      // and the bar's own edges are heavier still.
      for (let s = 0; s <= stepsPerBar; s += 1) {
        const isEdge = s === 0 || s === stepsPerBar;
        const isBeat = s % subdivision === 0;
        out.push(
          <line key={`v${bar.index}-${s}`} x1={x + s * CELL} y1={GRID_TOP} x2={x + s * CELL} y2={gridBottom}
            style={isBeat ? GRID_BEAT : GRID} strokeWidth={isEdge ? 1.8 : (isBeat ? 1.2 : 0.6)} />,
        );
      }

      // Beat numbers under the bar-number strip. Beat 1 is skipped: the bar number
      // already sits in that corner, and "1₁" at every bar line is noise.
      for (let s = subdivision; s < stepsPerBar; s += subdivision) {
        out.push(
          <text key={`b${bar.index}-${s}`} x={x + s * CELL + CELL / 2} y={GRID_TOP - 1.5} fontSize={8}
            style={LABEL} fontFamily={UI_FONT} textAnchor="middle">
            {s / subdivision + 1}
          </text>,
        );
      }

      // Hits.
      pieces.forEach((id, ri) => {
        const cells = cellsFor(bar.index, id);
        if (!cells) return;
        const cy = rowCenterY(ri);
        cells.forEach((cell, s) => {
          if (cell.rest) return;
          pushHit(out, cell, id, x + s * CELL + CELL / 2, cy, `h${bar.index}-${id}-${s}`);
        });
      });

      // Optional tap targets (a future click-to-toggle editor); absent by default
      // so the sheet is a plain image with no stray interactive nodes.
      if (onStepClick) {
        pieces.forEach((id, ri) => {
          for (let s = 0; s < stepsPerBar; s += 1) {
            out.push(
              <rect key={`t${bar.index}-${id}-${s}`} x={x + s * CELL} y={GRID_TOP + ri * ROW_H} width={CELL} height={ROW_H}
                fill="transparent" style={{ cursor: 'pointer' }} onClick={() => onStepClick(bar.index, s, id)} />,
            );
          }
        });
      }
    });
    // Every other value this reads (pieces / subdivision / stepsPerBar /
    // gridBottom / barX / barW) derives from `chart`, so it is not a dep.
    return <g>{out}</g>;
  }, [chart, cellsFor, onStepClick]);

  if (!chart.bars.length) {
    return (
      <div className={`text-sm text-gray-500 ${className}`}>
        {chart.errors.length > 0
          ? 'No readable bars in this drum chart yet — check the notes below.'
          : 'No drum chart yet — add piece rows like "HH: x x x x".'}
        {chart.errors.length > 0 && <ErrorSummary errors={chart.errors} />}
      </div>
    );
  }

  // One guard for both selection-derived values: a row index of -1 means the
  // selection no longer belongs to this chart (the frame between a live edit and
  // the reset effect below), and there is nothing to box or to describe.
  const selectedRow = selection ? pieces.indexOf(selection.piece) : -1;
  const info = selectedRow < 0
    ? null
    : describeDrumCell(selection.piece, cellsFor(selection.bar, selection.piece)?.[selection.step]);

  return (
    <div className={className} style={{ fontSize: `${fontSizeRem}rem` }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-1.5 text-xs text-gray-500">
        <span>{chart.time.beats}/{chart.time.beatValue}</span>
        {/* The tempo counts NOTATED beats — the time-signature denominator — so
            6/8 is eighth = bpm, not quarter = bpm. Label the actual beat unit
            rather than always printing ♩, which would misstate the tempo the
            playback schedule uses (drumPlayback.buildDrumSchedule). */}
        <span>{BEAT_GLYPH[chart.time.beatValue] || `1/${chart.time.beatValue}`} = {chart.tempo}</span>
        <span>{chart.subdivision} per beat</span>
        <span>{chart.bars.length} bar{chart.bars.length === 1 ? '' : 's'}</span>
        {explain && (
          <button
            type="button"
            onClick={() => setLegendOpen((open) => !open)}
            aria-expanded={legendOpen}
            aria-controls={legendId}
            className={`ml-auto px-3 ${ctrlBtnClass} ${legendOpen ? activeCtrlClass : ''}`}
          >
            Legend
          </button>
        )}
      </div>

      {/* The hint sits ABOVE the strip: on a phone the readout appears below the
          lane, and a hint underneath it would be the last thing found. */}
      {explain && !info && (
        <p className="mb-1.5 text-xs text-gray-600">Tap any note to learn what it means.</p>
      )}

      <div className="flex items-start">
        <LabelColumn pieces={pieces} height={height} scale={scale} />
        {/* One scroller for the whole song. `overscroll-contain` keeps a swipe
            that runs off the end of the strip from turning into a page/back
            gesture on a phone. */}
        <div ref={scrollRef} className="flex-1 min-w-0 overflow-x-auto overscroll-x-contain">
          {/* The label column is aria-hidden (a visual freeze of these same row
              names), so the kit rows are named in the strip's own label. */}
          <svg
            ref={laneRef}
            viewBox={`0 0 ${laneW} ${height}`}
            width={laneW * scale}
            height={height * scale}
            role="img"
            aria-label={`Drum chart — ${chart.bars.length} bar${chart.bars.length === 1 ? '' : 's'}, ${chart.time.beats}/${chart.time.beatValue} at ${chart.tempo} BPM. Kit rows: ${pieces.map((id) => kitPiece(id)?.label || id).join(', ')}${explain ? '. Tap a note, or use the arrow keys, for an explanation of it' : ''}`}
            // Explain mode hit-tests taps arithmetically (see selectFromPoint),
            // so the whole lane is one listener instead of a rect per cell. The
            // lane also takes focus so ←/→ can walk the hits — the tap gesture's
            // keyboard equivalent, alongside the Legend button.
            onClick={explain ? (e) => selectFromPoint(e.clientX, e.clientY) : undefined}
            onKeyDown={explain ? onLaneKeyDown : undefined}
            tabIndex={explain ? 0 : undefined}
            style={{ display: 'block', cursor: explain ? 'pointer' : undefined }}
          >
            {/* Playhead column — first in the tree so the grid and glyphs paint
                over it; the line is last so it paints over them. Both are
                positioned by the rAF loop and hidden until it runs. A full-height
                line rather than a line-plus-marker: the header strip is already
                two rows of small text deep, and any glyph big enough to read
                would sit on top of the beat numbers. */}
            <rect data-playhead="column" ref={columnRef} x={0} y={GRID_TOP} width={CELL} height={gridBottom - GRID_TOP}
              style={{ ...ACTIVE_FILL, display: 'none' }} />
            {/* Which note the readout is describing. Under the glyphs so the box
                frames the note rather than washing over it. */}
            {selectedRow >= 0 && (
              <rect data-selected-cell="" x={barX(selection.bar) + selection.step * CELL} y={GRID_TOP + selectedRow * ROW_H}
                width={CELL} height={ROW_H} rx={3} style={SELECT_BOX} strokeWidth={1.4} />
            )}
            {lane}
            <line data-playhead="line" ref={lineRef} x1={0} y1={PAD} x2={0} y2={gridBottom}
              style={{ ...ACTIVE_STROKE, display: 'none' }} strokeWidth={1.6} />
          </svg>
        </div>
      </div>

      {info && (
        <HitReadout
          info={info}
          position={describeDrumPosition(selection.bar, selection.step, subdivision)}
          onClose={() => setSelection(null)}
        />
      )}
      {legendOpen && <KitLegend id={legendId} pieces={pieces} />}

      {chart.errors.length > 0 && <ErrorSummary errors={chart.errors} />}
    </div>
  );
}

// Every prop is a primitive or the stable `getPlayhead` callback, and the
// playhead itself never arrives as a prop — so during playback memo bails out
// and the lane is never rebuilt. Selecting a note DOES re-render (it's local
// state), which is why the lane's element array is itself memoized.
export default memo(DrumSheetView);
