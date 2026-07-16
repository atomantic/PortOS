import { memo, useMemo } from 'react';
import { getChordVoicing, splitJoinedChords } from '../../lib/chordShapes.js';

/**
 * Small chord-voicing diagram for the SongBook viewer's instrument views:
 * an inline SVG fretbox for guitar (6-string) and ukulele (4-string) — nut,
 * frets, strings, finger dots, open (o) / muted (x) markers, and a "Nfr"
 * window label when the shape sits above the nut — and a compact note-chip
 * row for piano. Slash chords add a "/G bass" hint (piano prepends the bass
 * chip instead).
 *
 * Sized to fit a ~140px-wide popover (`size="md"`, default) or the
 * chords-used strip (`size="sm"`). Theme-aware: all strokes/text use
 * currentColor from the surrounding text color; dots pick up port-accent.
 * Unknown chords render a muted "no diagram" fallback — never crash.
 */

const SIZES = {
  sm: { cell: 11, row: 12, dot: 3.2, font: 7 },
  md: { cell: 16, row: 15, dot: 4.5, font: 8.5 },
};

const FretboxDiagram = ({ voicing, size }) => {
  const s = SIZES[size] || SIZES.md;
  const { frets, baseFret } = voicing;
  const gaps = frets.length - 1;
  const rows = Math.max(4, ...frets.filter((f) => f > 0));
  const left = baseFret > 1 ? s.font * 2.6 : 6;
  const top = s.row * 0.8;
  const width = left + gaps * s.cell + 6;
  const height = top + rows * s.row + 4;
  const stringX = (i) => left + i * s.cell;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="text-gray-400"
    >
      {/* Nut (thick at first position) + frets */}
      {Array.from({ length: rows + 1 }, (_, j) => (
        <line
          key={`f${j}`}
          x1={stringX(0)}
          y1={top + j * s.row}
          x2={stringX(gaps)}
          y2={top + j * s.row}
          stroke="currentColor"
          strokeWidth={j === 0 && baseFret === 1 ? 2.5 : 0.75}
        />
      ))}
      {/* Strings */}
      {frets.map((_, i) => (
        <line
          key={`s${i}`}
          x1={stringX(i)}
          y1={top}
          x2={stringX(i)}
          y2={top + rows * s.row}
          stroke="currentColor"
          strokeWidth={0.75}
        />
      ))}
      {/* Window label when the shape sits above the nut */}
      {baseFret > 1 && (
        <text
          x={left - 4}
          y={top + s.row * 0.5 + s.font * 0.38}
          textAnchor="end"
          fontSize={s.font}
          fill="currentColor"
        >
          {baseFret}fr
        </text>
      )}
      {/* Open / muted markers above the nut */}
      {frets.map((f, i) => {
        if (f > 0) return null;
        return f === 0 ? (
          <circle
            key={`m${i}`}
            cx={stringX(i)}
            cy={top - s.row * 0.42}
            r={s.dot * 0.62}
            fill="none"
            stroke="currentColor"
            strokeWidth={0.9}
          />
        ) : (
          <text
            key={`m${i}`}
            x={stringX(i)}
            y={top - s.row * 0.18}
            textAnchor="middle"
            fontSize={s.font}
            fill="currentColor"
          >
            ×
          </text>
        );
      })}
      {/* Finger dots */}
      <g className="text-port-accent">
        {frets.map((f, i) => (f > 0 ? (
          <circle
            key={`d${i}`}
            cx={stringX(i)}
            cy={top + (f - 0.5) * s.row}
            r={s.dot}
            fill="currentColor"
          />
        ) : null))}
      </g>
    </svg>
  );
};

const PianoChips = ({ voicing, size }) => (
  <span className={`inline-flex flex-wrap items-center ${size === 'sm' ? 'gap-0.5' : 'gap-1'}`}>
    {voicing.bass && (
      <span className={`rounded border border-port-border bg-port-bg text-gray-400 font-mono ${size === 'sm' ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[11px]'}`}>
        {voicing.bass}
        <span className="text-gray-600"> bass</span>
      </span>
    )}
    {voicing.notes.map((note, i) => (
      <span
        key={`${note}-${i}`}
        className={`rounded border border-port-accent/30 bg-port-accent/10 text-port-accent font-mono font-semibold ${size === 'sm' ? 'px-1 py-0.5 text-[9px]' : 'px-1.5 py-0.5 text-[11px]'}`}
      >
        {note}
      </span>
    ))}
  </span>
);

const SingleChordDiagram = ({ name, instrument, size }) => {
  const voicing = getChordVoicing(name, instrument);
  if (!voicing) {
    return <span className="text-[10px] text-gray-500 italic">no diagram</span>;
  }
  if (voicing.instrument === 'piano') {
    return <PianoChips voicing={voicing} size={size} />;
  }
  return (
    <span className="inline-flex flex-col items-center">
      <FretboxDiagram voicing={voicing} size={size} />
      {voicing.bass && (
        <span className="text-[9px] text-gray-500 leading-tight">/{voicing.bass} bass</span>
      )}
    </span>
  );
};

function ChordDiagram({ name, instrument, size = 'md' }) {
  // Dash-joined quick changes ("Am-Am7") arrive as one token from the parser —
  // render one voicing per segment, labeled when there's more than one.
  const parts = useMemo(() => splitJoinedChords(name), [name]);

  if (parts.length <= 1) {
    return <SingleChordDiagram name={parts[0] ?? name} instrument={instrument} size={size} />;
  }
  return (
    <span className="inline-flex items-start gap-2">
      {parts.map((part, i) => (
        <span key={`${part}-${i}`} className="inline-flex flex-col items-center gap-0.5">
          <span className="text-[9px] text-gray-500 font-mono leading-tight">{part}</span>
          <SingleChordDiagram name={part} instrument={instrument} size={size} />
        </span>
      ))}
    </span>
  );
}

// Pure function of primitive props — memo keeps sheet re-renders (autoscroll
// ticks, popover moves) from redrawing every strip diagram.
export default memo(ChordDiagram);
