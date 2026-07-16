import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { parseTabSheet } from '../../lib/tabNotation.js';
import ChordDiagram from './ChordDiagram.jsx';

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
 * `format='plain'` bypasses parsing entirely and renders the raw text
 * verbatim — the explicit opt-out of ALL notation UI (headings, chord
 * highlighting, popovers, and the chords-used strip alike).
 *
 * Instrument-view support (issue #2656): `instrumentView`
 * ('guitar'|'ukulele'|'piano', default 'guitar') drives the chord diagrams —
 * every chord token is a tappable/keyboard-activatable button that opens a
 * viewport-clamped popover with the voicing for the active instrument, and
 * because `text` arrives already transposed the diagrams follow the transposed
 * names for free. Tab staffs are guitar-specific, so non-guitar views collapse
 * each staff block to a one-line note with an inline "show" expand.
 * `showChordStrip` adds a collapsible "chords used" strip (unique chords in
 * order of first appearance, each with a mini diagram) above the sheet — the
 * viewer enables it; editor/import previews keep it off.
 */

const POPOVER_WIDTH = 172;
const POPOVER_EST_HEIGHT = 200;

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

// Build the padded chord row for a chordlyric line as segments: each chord
// name lands at its col offset into the lyric; names that would collide keep
// one space.
const chordRowSegments = (chords) => {
  const segments = [];
  let length = 0;
  for (const { name, col } of chords) {
    let pad = '';
    if (length < col) pad = ' '.repeat(col - length);
    else if (length > 0) pad = ' ';
    if (pad) {
      segments.push({ text: pad, chord: false });
      length += pad.length;
    }
    segments.push({ text: name, chord: true });
    length += name.length;
  }
  return segments;
};

// A tappable chord token. `inline` keeps vertical padding from growing the
// line box (it paints outside instead), so the enlarged touch target doesn't
// disturb the monospace sheet layout; horizontal padding cancels via negative
// margins.
const ChordToken = ({ name, tokenKey, expanded, onTap }) => (
  <button
    type="button"
    onClick={(e) => onTap(name, tokenKey, e.currentTarget)}
    aria-expanded={expanded}
    aria-haspopup="dialog"
    className="inline align-baseline text-port-accent font-semibold rounded px-1 -mx-1 py-2 hover:bg-port-accent/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-port-accent"
  >
    {name}
  </button>
);

const ChordSegments = ({ segments, blockKey, activeKey, onTap }) =>
  segments.map((seg, i) => {
    if (!seg.chord) return <span key={i}>{seg.text}</span>;
    const tokenKey = `${blockKey}:${i}`;
    return (
      <ChordToken
        key={i}
        name={seg.text}
        tokenKey={tokenKey}
        expanded={activeKey === tokenKey}
        onTap={onTap}
      />
    );
  });

function TabSheetView({
  text,
  format = 'tab',
  fontSizeRem = 0.875,
  className = '',
  instrumentView = 'guitar',
  showChordStrip = false,
}) {
  const plain = format === 'plain';
  const { lines } = useMemo(
    // 'plain' is the explicit opt-out of notation parsing: render every line
    // verbatim (no section headings, no chord highlighting — and no chord
    // popovers/strip either) so the stored format selector has an observable
    // effect.
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

  // Unique chord names in order of first appearance (chords-used strip).
  const usedChords = useMemo(() => {
    if (!showChordStrip) return [];
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      for (const { name } of line.chords || []) {
        if (name && !/^N\.?C\.?$/.test(name) && !seen.has(name)) {
          seen.add(name);
          out.push(name);
        }
      }
    }
    return out;
  }, [lines, showChordStrip]);
  const [stripOpen, setStripOpen] = useState(true);

  // Chord popover: { name, key, x, y, above } in viewport (fixed) coords.
  const [popover, setPopover] = useState(null);
  const popoverRef = useRef(null);
  // Tabstaff blocks explicitly expanded while in a non-guitar view.
  const [expandedStaffs, setExpandedStaffs] = useState(() => new Set());

  // New text (edit, transpose) invalidates block indices and chord names.
  useEffect(() => {
    setPopover(null);
    setExpandedStaffs(new Set());
  }, [text]);

  const onChordTap = useCallback((name, key, el) => {
    setPopover((prev) => {
      if (prev?.key === key) return null; // tap again to close
      const rect = el.getBoundingClientRect();
      const x = Math.max(
        8,
        Math.min(rect.left + rect.width / 2 - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8),
      );
      // Open below unless the viewport bottom is too close (then flip above).
      const above = window.innerHeight - rect.bottom < POPOVER_EST_HEIGHT && rect.top > POPOVER_EST_HEIGHT;
      return { name, key, x, y: above ? rect.top - 6 : rect.bottom + 6, above };
    });
  }, []);

  // Escape / tap-outside close while the popover is open.
  useEffect(() => {
    if (!popover) return undefined;
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setPopover(null);
    };
    const onPointerDown = (e) => {
      if (popoverRef.current?.contains(e.target)) return;
      // Chord tokens manage their own open/toggle in onClick — closing here on
      // the preceding pointerdown would make a second tap close-then-reopen.
      if (e.target.closest?.('[aria-haspopup="dialog"]')) return;
      setPopover(null);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [popover]);

  // 'plain' bypass — after the hooks above (they must run unconditionally)
  // and before any notation UI: verbatim text, no strip, no popovers.
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
      {showChordStrip && usedChords.length > 0 && (
        <div className="mb-3 border border-port-border rounded-lg bg-port-card/50 font-sans">
          <button
            type="button"
            onClick={() => setStripOpen((open) => !open)}
            aria-expanded={stripOpen}
            className="w-full flex items-center gap-1.5 px-3 py-2 min-h-[44px] text-xs text-gray-400 hover:text-white"
          >
            {stripOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <span className="font-semibold">Chords used</span>
            <span className="text-gray-500">({usedChords.length})</span>
          </button>
          {stripOpen && (
            <div className="flex flex-wrap items-end gap-x-4 gap-y-2 px-3 pb-3">
              {usedChords.map((name) => (
                <div key={name} className="flex flex-col items-center gap-0.5">
                  <span className="text-[11px] font-mono font-semibold text-port-accent">{name}</span>
                  <ChordDiagram name={name} instrument={instrumentView} size="sm" />
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {blocks.map((block, bi) => {
        if (block.type === 'tabstaff') {
          // Tab staffs are guitar-specific — collapse them in other views.
          if (instrumentView !== 'guitar' && !expandedStaffs.has(bi)) {
            return (
              <div key={bi} className="my-1 flex items-center gap-2 text-xs text-gray-500 italic font-sans">
                <span>guitar tab — switch to Guitar view</span>
                <button
                  type="button"
                  onClick={() => setExpandedStaffs((prev) => new Set(prev).add(bi))}
                  className="not-italic text-port-accent hover:underline px-1 py-2 -my-2"
                >
                  show
                </button>
              </div>
            );
          }
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
            return (
              <div key={bi} className="whitespace-pre-wrap">
                <ChordSegments
                  segments={chordLineSegments(line.text, line.chords)}
                  blockKey={bi}
                  activeKey={popover?.key ?? null}
                  onTap={onChordTap}
                />
              </div>
            );
          case 'chordlyric':
            return (
              <div key={bi} className="overflow-x-auto">
                <div className="whitespace-pre text-port-accent font-semibold leading-tight">
                  <ChordSegments
                    segments={chordRowSegments(line.chords)}
                    blockKey={bi}
                    activeKey={popover?.key ?? null}
                    onTap={onChordTap}
                  />
                </div>
                <div className="whitespace-pre">{line.text || ' '}</div>
              </div>
            );
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

      {popover && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`${popover.name} chord voicing`}
          className="fixed z-50 bg-port-card border border-port-border rounded-lg shadow-xl p-3 font-sans"
          style={{
            left: popover.x,
            top: popover.y,
            width: POPOVER_WIDTH,
            transform: popover.above ? 'translateY(-100%)' : undefined,
          }}
        >
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <span className="text-sm font-mono font-semibold text-port-accent">{popover.name}</span>
            <span className="text-[10px] uppercase tracking-wide text-gray-500">{instrumentView}</span>
          </div>
          <ChordDiagram name={popover.name} instrument={instrumentView} />
        </div>
      )}
    </div>
  );
}

// Props are all primitives (`format`/`instrumentView`/`showChordStrip`
// included), so memo makes re-renders of a host page (stage flips, autoscroll
// ticks) skip the full sheet re-render.
export default memo(TabSheetView);
