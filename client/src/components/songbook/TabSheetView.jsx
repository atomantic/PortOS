import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { parseTabSheet, TAB_ARTICULATIONS } from '../../lib/tabNotation.js';
import { splitJoinedChords } from '../../lib/chordShapes.js';
import usePopoverPosition from '../../hooks/usePopoverPosition.js';
import ChordDiagram from './ChordDiagram.jsx';
import { activeCtrlClass, ctrlBtnClass } from './constants.js';

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
 *
 * Play-along support (issue #4104): `soundingChord` — `{ lineIndex, chordIndex }`
 * or null — lights the chord token the synth preview is currently sounding, the
 * chord-sheet equivalent of `<DrumSheetView>`'s playhead. The coordinates are
 * the ones `sheetChordOccurrences` (lib/chordPlayback.js) hands out, i.e.
 * positions in `parseTabSheet(text).lines`, so the schedule and the sheet agree
 * on which token is which without either knowing how the other is built. Purely
 * presentational: the audio, the transport and the clock all live in
 * `useChordPlayer` / `<ChordTransportBar>`.
 */

const POPOVER_WIDTH = 172;

// Split a chords line into plain/chord segments using the parser's col offsets.
// Chord segments carry their index within the line's `chords` array — the other
// half of the `{ lineIndex, chordIndex }` coordinate the play-along highlight
// addresses tokens by.
const chordLineSegments = (text, chords) => {
  const segments = [];
  let cursor = 0;
  chords.forEach(({ name, col }, chordIndex) => {
    if (col > cursor) segments.push({ text: text.slice(cursor, col), chord: false });
    segments.push({ text: text.slice(col, col + name.length), chord: true, chordIndex });
    cursor = col + name.length;
  });
  if (cursor < text.length) segments.push({ text: text.slice(cursor), chord: false });
  return segments;
};

// Build the padded chord row for a chordlyric line as segments: each chord
// name lands at its col offset into the lyric; names that would collide keep
// one space.
const chordRowSegments = (chords) => {
  const segments = [];
  let length = 0;
  chords.forEach(({ name, col }, chordIndex) => {
    let pad = '';
    if (length < col) pad = ' '.repeat(col - length);
    else if (length > 0) pad = ' ';
    if (pad) {
      segments.push({ text: pad, chord: false });
      length += pad.length;
    }
    segments.push({ text: name, chord: true, chordIndex });
    length += name.length;
  });
  return segments;
};

// A tappable chord token. `inline` keeps vertical padding from growing the
// line box (it paints outside instead), so the enlarged touch target doesn't
// disturb the monospace sheet layout; horizontal padding cancels via negative
// margins.
const ChordToken = ({ name, tokenKey, expanded, sounding, onTap }) => (
  <button
    type="button"
    onClick={(e) => onTap(name, tokenKey, e.currentTarget)}
    aria-expanded={expanded}
    aria-haspopup="dialog"
    // The sounding token is marked in the DOM as well as painted: the highlight
    // is a background tint, which a test can't read and a high-contrast theme
    // may flatten.
    data-sounding={sounding ? '' : undefined}
    // font-mono is explicit (not inherited): PortOS themes set --port-font-ui
    // directly on every <button>, which would render chord names proportional
    // and break the sheet's column alignment.
    className={`inline align-baseline font-mono text-port-accent font-semibold rounded px-1 -mx-1 py-2 focus-visible:outline focus-visible:outline-1 focus-visible:outline-port-accent ${
      sounding ? 'bg-port-accent/25 ring-1 ring-port-accent' : 'hover:bg-port-accent/10'
    }`}
  >
    {name}
  </button>
);

const ChordSegments = ({ segments, blockKey, activeKey, soundingChordIndex, onTap }) =>
  segments.map((seg, i) => {
    if (!seg.chord) return <span key={i}>{seg.text}</span>;
    const tokenKey = `${blockKey}:${i}`;
    return (
      <ChordToken
        key={i}
        name={seg.text}
        tokenKey={tokenKey}
        expanded={activeKey === tokenKey}
        // `soundingChordIndex` is null when nothing on THIS line is sounding,
        // and a chord index is legitimately 0 — so compare explicitly rather
        // than leaning on truthiness.
        sounding={soundingChordIndex != null && soundingChordIndex === seg.chordIndex}
        onTap={onTap}
      />
    );
  });

const TabLegend = ({ id }) => (
  <div id={id} className="mb-3 rounded-lg border border-port-border bg-port-bg/60 px-3 py-2 text-xs font-sans">
    <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
      {TAB_ARTICULATIONS.map((articulation) => (
        <div key={articulation.char} className="flex items-start gap-2">
          <dt className="shrink-0 rounded border border-port-border bg-port-card px-1.5 font-mono text-sm text-port-accent">
            {articulation.char}
          </dt>
          <dd className="min-w-0 text-gray-300">
            <span className="font-semibold text-white">{articulation.name}</span> — {articulation.detail}
          </dd>
        </div>
      ))}
    </dl>
  </div>
);

function TabSheetView({
  text,
  format = 'tab',
  fontSizeRem = 0.875,
  className = '',
  instrumentView = 'guitar',
  showChordStrip = false,
  soundingChord = null,
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
  // the six strings of a staff scroll together. Each block keeps the index its
  // FIRST line had in `lines` — a non-staff block holds exactly one line, so
  // that index is the `lineIndex` the play-along highlight addresses.
  const blocks = useMemo(() => {
    const out = [];
    lines.forEach((line, lineIndex) => {
      const prev = out[out.length - 1];
      if (line.type === 'tabstaff' && prev?.type === 'tabstaff') prev.lines.push(line);
      else out.push({ type: line.type, lineIndex, lines: [line] });
    });
    return out;
  }, [lines]);
  const hasTabstaff = lines.some((line) => line.type === 'tabstaff');
  const [legendOpen, setLegendOpen] = useState(false);
  const legendId = useId();

  // Unique chord names in order of first appearance (chords-used strip).
  // Dash-joined quick changes split into their segments FIRST, so "Am-Am7"
  // plus a standalone "Am" contributes Am and Am7 exactly once each (and an
  // N.C. segment can't ride a joined token past the filter).
  const usedChords = useMemo(() => {
    if (!showChordStrip) return [];
    const seen = new Set();
    const out = [];
    for (const line of lines) {
      for (const { name } of line.chords || []) {
        for (const part of splitJoinedChords(name)) {
          if (part && !/^N\.?C\.?$/.test(part) && !seen.has(part)) {
            seen.add(part);
            out.push(part);
          }
        }
      }
    }
    return out;
  }, [lines, showChordStrip]);
  const [stripOpen, setStripOpen] = useState(true);

  // Chord popover: { name, key }; placement is owned by usePopoverPosition,
  // which re-measures on open and reflows (rAF-coalesced, capture-phase) on
  // ancestor scroll/resize — so autoscroll can't detach the dialog from its
  // trigger, and the measured height replaces any estimate.
  const [popover, setPopover] = useState(null);
  const anchorElRef = useRef(null);
  const { popoverRef, style: popoverStyle } = usePopoverPosition({
    open: !!popover,
    width: POPOVER_WIDTH,
    position: 'below',
    anchorRef: anchorElRef,
    // popover?.key: tapping a DIFFERENT occurrence of the same chord swaps
    // the anchor element without changing name/view — the key forces a
    // re-measure so the dialog moves to the newly-tapped token.
    contentDeps: [popover?.key, popover?.name, instrumentView],
  });
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
      anchorElRef.current = el;
      return { name, key };
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

      {hasTabstaff && (
        <div className="mb-1.5 flex justify-end font-sans">
          <button
            type="button"
            onClick={() => setLegendOpen((open) => !open)}
            aria-expanded={legendOpen}
            aria-controls={legendId}
            className={`px-3 ${ctrlBtnClass} ${legendOpen ? activeCtrlClass : ''}`}
          >
            Legend
          </button>
        </div>
      )}
      {hasTabstaff && legendOpen && <TabLegend id={legendId} />}

      {blocks.map((block, bi) => {
        if (block.type === 'tabstaff') {
          // Collapse staffs that don't belong to the active view: a ≥5-line
          // staff is guitar tab (collapsed outside Guitar view); a ≤4-line
          // staff is plausibly ukulele/bass tab, so the Ukulele view keeps it
          // — a uke song's own native tab must not hide under a "guitar tab"
          // note. Piano has no tablature, so Piano view collapses every staff.
          const looksGuitar = block.lines.length >= 5;
          const collapse = instrumentView === 'piano'
            ? true
            : instrumentView === 'ukulele' && looksGuitar;
          if (collapse && !expandedStaffs.has(bi)) {
            return (
              <div key={bi} className="my-1 flex items-center gap-2 text-xs text-gray-500 italic font-sans">
                <span>{looksGuitar ? 'guitar tab — switch to Guitar view' : 'tablature — switch to Guitar or Ukulele view'}</span>
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
        // Null unless the sounding chord belongs to THIS line — so a chord index
        // can never light the same-numbered token on a different line.
        const soundingChordIndex = soundingChord?.lineIndex === block.lineIndex
          ? soundingChord.chordIndex
          : null;
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
                  soundingChordIndex={soundingChordIndex}
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
                    soundingChordIndex={soundingChordIndex}
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
          // max-h + overflow: a many-segment dash-joined token wraps voicings
          // into rows that can exceed a short/mobile viewport — the popover
          // scrolls internally instead of stranding lower diagrams offscreen.
          className="fixed z-50 bg-port-card border border-port-border rounded-lg shadow-xl p-3 font-sans max-h-[min(60vh,480px)] overflow-y-auto"
          style={popoverStyle ?? { visibility: 'hidden', left: 0, top: 0, width: POPOVER_WIDTH }}
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
// included) apart from `soundingChord`, which the host memoizes and which only
// changes when the sounding chord does (once a bar, not once a frame) — so memo
// makes re-renders of a host page (stage flips, autoscroll ticks) skip the full
// sheet re-render.
export default memo(TabSheetView);
