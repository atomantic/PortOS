import { createPortal } from 'react-dom';
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { parseTabSheet, TAB_ARTICULATIONS, chordLineSegments, pairedLineChunks, chordLyricRows } from '../../lib/tabNotation.js';
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
 * - chords/lyric and chordlyric → paired word groups that wrap both rows together
 * - standalone chords → highlighted monospace chord line
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

// A tappable chord token. Paired rows reserve its vertical touch padding;
// horizontal padding cancels via negative margins to retain column alignment.
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
  soundingChord = null,
}) {
  const plain = format === 'plain';
  const { lines } = useMemo(
    // 'plain' is the explicit opt-out of notation parsing: render every line
    // verbatim (no section headings, no chord highlighting — and no chord
    // popovers either) so the stored format selector has an observable
    // effect.
    () => (plain ? { lines: [] } : parseTabSheet(text)),
    [text, plain],
  );

  // Group consecutive tabstaff lines into one horizontally-scrollable block so
  // the six strings of a staff scroll together. Each block keeps the index its
  // FIRST line had in `lines`; a chord/lyric pair keeps the chord line index
  // that the play-along highlight addresses.
  const blocks = useMemo(() => {
    const out = [];
    lines.forEach((line, lineIndex) => {
      const prev = out[out.length - 1];
      if (line.type === 'lyric' && prev?.type === 'chords') prev.lines.push(line);
      else if (line.type === 'tabstaff' && prev?.type === 'tabstaff') prev.lines.push(line);
      else out.push({ type: line.type, lineIndex, lines: [line] });
    });
    return out;
  }, [lines]);
  const hasTabstaff = lines.some((line) => line.type === 'tabstaff');
  const [legendOpen, setLegendOpen] = useState(false);
  const legendId = useId();
  const staffIdPrefix = useId();

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
          const staffId = `${staffIdPrefix}-staff-${bi}`;
          if (collapse && !expandedStaffs.has(bi)) {
            return (
              <div key={bi} className="my-1 flex items-center gap-2 text-xs text-gray-500 italic font-sans">
                <span>{looksGuitar ? 'guitar tab — switch to Guitar view' : 'tablature — switch to Guitar or Ukulele view'}</span>
                <button
                  type="button"
                  onClick={() => setExpandedStaffs((prev) => new Set(prev).add(bi))}
                  aria-label={`Show ${looksGuitar ? 'guitar ' : ''}tablature staff (section ${bi + 1})`}
                  aria-expanded={false}
                  aria-controls={staffId}
                  className="not-italic text-port-accent hover:underline px-1 py-2 -my-2"
                >
                  show
                </button>
              </div>
            );
          }
          return (
            <div id={staffId} key={bi} className="overflow-x-auto whitespace-pre text-gray-300 my-1">
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
        if (line.type === 'chordlyric' || (line.type === 'chords' && block.lines.length === 2)) {
          const rows = line.type === 'chordlyric'
            ? chordLyricRows(line)
            : { lyric: block.lines[1].text, chordText: line.text, chords: line.chords };
          return (
            <div key={bi} className="flex flex-wrap overflow-x-auto" data-chord-lyric-pair="">
              {pairedLineChunks(rows.lyric, rows.chordText, rows.chords).map((chunk, ci) => (
                <div key={ci} className="shrink-0 whitespace-pre" data-chord-lyric-chunk="">
                  <div className="h-[calc(1.5em+1rem)]">
                    <ChordSegments
                      segments={chunk.segments}
                      blockKey={`${bi}:${ci}`}
                      activeKey={popover?.key ?? null}
                      soundingChordIndex={soundingChordIndex}
                      onTap={onChordTap}
                    />
                  </div>
                  <div className="min-h-[1.5em]">{chunk.lyric}</div>
                </div>
              ))}
            </div>
          );
        }
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

      {popover && createPortal(
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
          <button type="button" className="mt-2 text-sm text-port-accent py-2 w-full" onClick={() => {
            setPopover(null);
            anchorElRef.current?.focus();
          }}>Close chord diagram</button>
        </div>,
        document.body,
      )}
    </div>
  );
}

// Props are all primitives (`format`/`instrumentView` included) apart from
// `soundingChord`, which the host memoizes and which only changes when the
// sounding chord does (once a bar, not once a frame) — so memo
// makes re-renders of a host page (stage flips, autoscroll ticks) skip the full
// sheet re-render.
export default memo(TabSheetView);
