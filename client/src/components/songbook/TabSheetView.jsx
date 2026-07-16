import { memo, useMemo } from 'react';
import { parseTabSheet } from '../../lib/tabNotation.js';

/**
 * Rendered tab/chord sheet — the shared display surface for the SongBook
 * viewer's play mode, the editor's live preview, and the import preview.
 *
 * Takes the (already-transposed) sheet `text` and renders parseTabSheet's
 * classified lines:
 * - section     → styled heading
 * - chords      → monospace line with each chord token highlighted at its
 *                 original column (whitespace-pre keeps alignment)
 * - chordlyric  → chord row built from col offsets rendered above the bare lyric
 * - tabstaff    → consecutive staff lines grouped in one overflow-x-auto block
 *                 so a wide staff scrolls as a unit without wrapping
 * - lyric/text  → plain monospace pre-wrap
 *
 * `fontSizeRem` scales the whole sheet (viewer font ± control).
 */

// Split a chords line into plain/chord segments using the parser's col offsets.
const chordLineSegments = (text, chords) => {
  const segments = [];
  let cursor = 0;
  for (const { name, col } of chords) {
    if (col > cursor) segments.push({ text: text.slice(cursor, col), chord: false });
    segments.push({ text: text.slice(col, col + name.length), chord: true });
    cursor = col + name.length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), chord: false });
  return segments;
};

// Build the padded chord row for a chordlyric line: each chord name lands at
// its col offset into the lyric; names that would collide keep one space.
const buildChordRow = (chords) => {
  let row = '';
  for (const { name, col } of chords) {
    if (row.length < col) row += ' '.repeat(col - row.length);
    else if (row.length > 0) row += ' ';
    row += name;
  }
  return row;
};

const ChordsLine = ({ line }) => (
  <div className="whitespace-pre-wrap">
    {chordLineSegments(line.text, line.chords).map((seg, i) =>
      seg.chord
        ? <span key={i} className="text-port-accent font-semibold">{seg.text}</span>
        : <span key={i}>{seg.text}</span>)}
  </div>
);

const ChordLyricLine = ({ line }) => (
  <div className="overflow-x-auto">
    <div className="whitespace-pre text-port-accent font-semibold leading-tight">
      {buildChordRow(line.chords)}
    </div>
    <div className="whitespace-pre">{line.text || ' '}</div>
  </div>
);

function TabSheetView({ text, format = 'tab', fontSizeRem = 0.875, className = '' }) {
  const plain = format === 'plain';
  const { lines } = useMemo(
    // 'plain' is the explicit opt-out of notation parsing: render every line
    // verbatim (no section headings, no chord highlighting) so the stored
    // format selector has an observable effect.
    () => (plain ? { lines: [] } : parseTabSheet(text)),
    [text, plain],
  );

  // Group consecutive tabstaff lines into one horizontally-scrollable block so
  // the six strings of a staff scroll together.
  const blocks = useMemo(() => {
    const out = [];
    for (const line of lines) {
      const prev = out[out.length - 1];
      if (line.type === 'tabstaff' && prev?.type === 'tabstaff') prev.lines.push(line);
      else out.push({ type: line.type, lines: [line] });
    }
    return out;
  }, [lines]);

  if (plain) {
    return (
      <div
        className={`font-mono text-gray-200 whitespace-pre-wrap ${className}`}
        style={{ fontSize: `${fontSizeRem}rem`, lineHeight: 1.5 }}
      >
        {text}
      </div>
    );
  }

  return (
    <div className={`font-mono text-gray-200 ${className}`} style={{ fontSize: `${fontSizeRem}rem`, lineHeight: 1.5 }}>
      {blocks.map((block, bi) => {
        if (block.type === 'tabstaff') {
          return (
            <div key={bi} className="overflow-x-auto whitespace-pre text-gray-300 my-1">
              {block.lines.map((line, li) => <div key={li}>{line.text}</div>)}
            </div>
          );
        }
        const line = block.lines[0];
        switch (line.type) {
          case 'section':
            // {end_of_*} directives carry an empty label — render nothing visible.
            return line.label
              ? (
                <div key={bi} className="mt-4 mb-1 text-port-accent font-bold uppercase tracking-wide text-[0.85em]">
                  {line.label}
                </div>
              )
              : <div key={bi} className="mb-1" />;
          case 'chords':
            return <ChordsLine key={bi} line={line} />;
          case 'chordlyric':
            return <ChordLyricLine key={bi} line={line} />;
          case 'blank':
            return <div key={bi}>{' '}</div>;
          case 'directive':
            // ChordPro meta plumbing ({title:}/{key:}/{capo:}) — the values
            // surface in the viewer's badges/fields, not as raw text.
            return null;
          case 'lyric':
          case 'text':
          default:
            return <div key={bi} className="whitespace-pre-wrap">{line.text}</div>;
        }
      })}
    </div>
  );
}

// Props are all primitives, so memo makes re-renders of a host page (stage
// flips, autoscroll ticks) skip the full sheet re-render.
export default memo(TabSheetView);
