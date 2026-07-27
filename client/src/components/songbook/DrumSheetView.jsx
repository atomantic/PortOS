/**
 * DrumSheetView — renders PortOS drum-kit notation (drumNotation.js) as a
 * labelled, bar-gridded kit sheet in hand-rolled SVG, with no engraving library
 * (the same explicit choice `ScoreSheet.jsx` makes: no VexFlow / abcjs / OSMD).
 *
 * Geometry is driven off ONE constant — the grid cell size. Every row is a kit
 * piece, every column a grid step, so positioning a hit is a single multiply.
 * Beat boundaries get a heavier grid line so a 16th-note row still reads in
 * fours, and each hit's glyph follows its cell: a cross for cymbals/hats, a
 * filled notehead for drums, a ring for an open hi-hat, a small hollow head for
 * a ghost, a doubled head for a flam, all with the accent's own chevron.
 *
 * Ink comes from the PortOS theme CSS variables (`--port-text` / `--port-accent`
 * / `--port-text-muted`) applied through the `style` prop — SVG presentation
 * *attributes* don't evaluate `var()`, so `fill="var(--x)"` would silently paint
 * nothing. Same rule as ScoreSheet.
 *
 * Each bar is its own SVG so bars wrap responsively and a wide bar scrolls as a
 * UNIT on a narrow screen (mobile-responsive is non-negotiable) instead of
 * squeezing its columns into illegibility.
 *
 * Props:
 *   text        — the raw chart source (parsed here; the parser never throws)
 *   fontSizeRem — scales the labels/legend text with the viewer's font control
 *   activeStep  — `{ bar, step }` | null — draws the playhead column
 *   onStepClick — optional `(bar, step)` for a future tap-a-cell editor (#3115
 *                 out-of-scope); when absent the grid renders as a plain image
 */

import { memo, useMemo } from 'react';
import { parseDrumChart, kitPiece } from '../../lib/drumNotation.js';

// --- Geometry (internal SVG units; each bar's <svg> scales via viewBox) ------
const CELL = 22;              // one grid step — every other measure derives from this
const ROW_H = CELL;           // one kit-piece row
const LABEL_W = 74;           // room for the row labels ("Hi-Hat", "Floor Tom")
const PAD = 6;                // padding inside a bar's svg
const HEAD_R = CELL * 0.3;    // notehead radius
const GHOST_R = CELL * 0.2;
const CROSS_R = CELL * 0.26;
const HEADER_H = 18;          // bar-number / label strip above the grid

// Ink — theme CSS vars, applied via `style` (see the header note).
const INK = 'rgb(var(--port-text))';
const GRID = 'rgb(var(--port-text-muted) / 0.35)';
const GRID_BEAT = 'rgb(var(--port-text-muted) / 0.7)';
const LABEL = 'rgb(var(--port-text-muted))';
const ACTIVE = 'rgb(var(--port-accent))';
const ACTIVE_FILL = 'rgb(var(--port-accent) / 0.18)';
const UI_FONT = 'ui-sans-serif, system-ui, sans-serif';

const strokeStyle = (color) => ({ stroke: color });
const fillStyle = (color) => ({ fill: color });

// One hit's glyph. `cross` pieces (cymbals, hats) draw an ×; `head` pieces
// (drums) draw a notehead. The cell's own flags then modify it: a ring for an
// open hi-hat, a small hollow head for a ghost, a leading grace head for a flam,
// and a chevron above an accent.
const renderHit = (cell, piece, cx, cy, ink, key) => {
  const out = [];
  const cross = kitPiece(piece)?.glyph === 'cross';

  if (cell.flam) {
    // Grace note just ahead of the beat — small and offset left.
    const gx = cx - CELL * 0.3;
    out.push(cross
      ? <line key={`${key}-fl1`} x1={gx - GHOST_R} y1={cy - GHOST_R} x2={gx + GHOST_R} y2={cy + GHOST_R} style={strokeStyle(ink)} strokeWidth={1.1} />
      : <circle key={`${key}-fl1`} cx={gx} cy={cy} r={GHOST_R} style={{ fill: 'none', stroke: ink }} strokeWidth={1.1} />);
    if (cross) {
      out.push(<line key={`${key}-fl2`} x1={gx - GHOST_R} y1={cy + GHOST_R} x2={gx + GHOST_R} y2={cy - GHOST_R} style={strokeStyle(ink)} strokeWidth={1.1} />);
    }
  }

  if (cross) {
    const r = cell.ghost ? GHOST_R : CROSS_R;
    const w = cell.accent ? 2.2 : 1.6;
    out.push(
      <line key={`${key}-a`} x1={cx - r} y1={cy - r} x2={cx + r} y2={cy + r} style={strokeStyle(ink)} strokeWidth={w} strokeLinecap="round" />,
      <line key={`${key}-b`} x1={cx - r} y1={cy + r} x2={cx + r} y2={cy - r} style={strokeStyle(ink)} strokeWidth={w} strokeLinecap="round" />,
    );
    // Open hi-hat: the conventional circle around the ×.
    if (cell.open) {
      out.push(<circle key={`${key}-o`} cx={cx} cy={cy} r={r + 2.6} style={{ fill: 'none', stroke: ink }} strokeWidth={1.2} />);
    }
  } else if (cell.ghost) {
    // Ghost note — the parenthesized/hollow head convention.
    out.push(<circle key={`${key}-h`} cx={cx} cy={cy} r={GHOST_R} style={{ fill: 'none', stroke: ink }} strokeWidth={1.2} />);
  } else {
    out.push(<circle key={`${key}-h`} cx={cx} cy={cy} r={HEAD_R} style={fillStyle(ink)} />);
  }

  if (cell.accent) {
    // Accent chevron above the head (the > articulation mark, rotated to sit
    // horizontally over the note).
    const y = cy - CELL * 0.42;
    out.push(
      <path key={`${key}-ac`}
        d={`M ${cx - HEAD_R - 1} ${y - 2.4} L ${cx + HEAD_R + 1} ${y} L ${cx - HEAD_R - 1} ${y + 2.4}`}
        style={{ fill: 'none', stroke: ink }} strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round" />,
    );
  }
  return out;
};

// One bar → its own <svg>. Kept a component (not a helper returning elements) so
// React can key/diff bars independently as the playhead moves.
const Bar = ({ bar, pieces, subdivision, activeStep, onStepClick }) => {
  const steps = bar.rows[0]?.cells.length || 0;
  const gridW = steps * CELL;
  const width = LABEL_W + gridW + PAD * 2;
  const height = HEADER_H + pieces.length * ROW_H + PAD * 2;
  const gridLeft = PAD + LABEL_W;
  const gridTop = PAD + HEADER_H;
  const gridBottom = gridTop + pieces.length * ROW_H;
  // Only the bar the playhead is IN highlights a column.
  const active = activeStep && activeStep.bar === bar.index ? activeStep.step : null;

  const els = [];

  // Bar number + label strip.
  els.push(
    <text key="num" x={PAD} y={PAD + 12} fontSize={11} fontWeight="600" style={fillStyle(LABEL)} fontFamily={UI_FONT}>
      {bar.index}
    </text>,
  );
  if (bar.label) {
    els.push(
      <text key="label" x={gridLeft} y={PAD + 12} fontSize={11} style={fillStyle(LABEL)} fontFamily={UI_FONT}>
        {bar.label}
        {bar.repeat > 1 ? ` (${bar.repeatPass}/${bar.repeat})` : ''}
      </text>,
    );
  }

  // Playhead column — drawn first so glyphs and grid lines sit on top of it.
  if (active != null && active >= 0 && active < steps) {
    els.push(
      <rect key="ph" x={gridLeft + active * CELL} y={gridTop} width={CELL} height={gridBottom - gridTop}
        style={fillStyle(ACTIVE_FILL)} />,
    );
  }

  // Row labels + horizontal lane lines.
  pieces.forEach((id, ri) => {
    const y = gridTop + ri * ROW_H;
    els.push(
      <text key={`rl${id}`} x={PAD} y={y + ROW_H / 2 + 3.5} fontSize={10} style={fillStyle(LABEL)} fontFamily={UI_FONT}>
        {kitPiece(id)?.label || id}
      </text>,
      <line key={`rh${id}`} x1={gridLeft} y1={y} x2={gridLeft + gridW} y2={y} style={strokeStyle(GRID)} strokeWidth={1} />,
    );
  });
  els.push(
    <line key="rh-last" x1={gridLeft} y1={gridBottom} x2={gridLeft + gridW} y2={gridBottom} style={strokeStyle(GRID)} strokeWidth={1} />,
  );

  // Vertical step lines — every `subdivision`-th is a beat boundary (heavier),
  // and the bar's own edges are heavier still.
  for (let s = 0; s <= steps; s += 1) {
    const x = gridLeft + s * CELL;
    const isEdge = s === 0 || s === steps;
    const isBeat = s % subdivision === 0;
    els.push(
      <line key={`v${s}`} x1={x} y1={gridTop} x2={x} y2={gridBottom}
        style={strokeStyle(isBeat ? GRID_BEAT : GRID)} strokeWidth={isEdge ? 1.8 : (isBeat ? 1.2 : 0.6)} />,
    );
  }

  // Beat numbers under the grid.
  for (let s = 0; s < steps; s += subdivision) {
    els.push(
      <text key={`bn${s}`} x={gridLeft + s * CELL + CELL / 2} y={gridTop - 3} fontSize={9}
        style={fillStyle(LABEL)} fontFamily={UI_FONT} textAnchor="middle">
        {s / subdivision + 1}
      </text>,
    );
  }

  // Hits.
  const rowByPiece = new Map(bar.rows.map((r) => [r.piece, r]));
  pieces.forEach((id, ri) => {
    const row = rowByPiece.get(id);
    if (!row) return;
    const cy = gridTop + ri * ROW_H + ROW_H / 2;
    row.cells.forEach((cell, s) => {
      if (cell.rest) return;
      const cx = gridLeft + s * CELL + CELL / 2;
      els.push(...renderHit(cell, id, cx, cy, s === active ? ACTIVE : INK, `h${id}-${s}`));
    });
  });

  // Optional tap targets (a future click-to-toggle editor); absent by default so
  // the sheet is a plain image with no stray interactive nodes.
  if (onStepClick) {
    pieces.forEach((id, ri) => {
      for (let s = 0; s < steps; s += 1) {
        els.push(
          <rect key={`t${id}-${s}`} x={gridLeft + s * CELL} y={gridTop + ri * ROW_H} width={CELL} height={ROW_H}
            fill="transparent" style={{ cursor: 'pointer' }} onClick={() => onStepClick(bar.index, s, id)} />,
        );
      }
    });
  }

  return (
    // The bar scrolls as a unit on a narrow viewport: the svg keeps its intrinsic
    // width and the wrapper scrolls, rather than the viewBox squeezing columns.
    <div className="overflow-x-auto max-w-full">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`Drum bar ${bar.index}${bar.label ? `: ${bar.label}` : ''}`}
        style={{ display: 'block', maxWidth: '100%', height: 'auto' }}
      >
        {els}
      </svg>
    </div>
  );
};

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

function DrumSheetView({ text, fontSizeRem = 0.875, activeStep = null, onStepClick, className = '' }) {
  const chart = useMemo(() => parseDrumChart(text), [text]);

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

  return (
    <div className={className} style={{ fontSize: `${fontSizeRem}rem` }}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-xs text-gray-500">
        <span>{chart.time.beats}/{chart.time.beatValue}</span>
        <span>♩ = {chart.tempo}</span>
        <span>
          {chart.subdivision} per beat
        </span>
        <span>{chart.bars.length} bar{chart.bars.length === 1 ? '' : 's'}</span>
      </div>

      <div className="flex flex-col gap-3">
        {chart.bars.map((bar) => (
          <Bar
            key={`${bar.index}`}
            bar={bar}
            pieces={chart.pieces}
            subdivision={chart.subdivision}
            activeStep={activeStep}
            onStepClick={onStepClick}
          />
        ))}
      </div>

      {chart.errors.length > 0 && <ErrorSummary errors={chart.errors} />}
    </div>
  );
}

// Props are primitives plus a shallow `activeStep` object, so memo keeps a host
// page's unrelated re-renders (stage flips, BPM edits) from redrawing the sheet.
export default memo(DrumSheetView);
