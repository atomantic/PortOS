import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Maximize2, Minimize2, ZoomIn, ZoomOut } from 'lucide-react';
import useMidiNotes from '../../hooks/useMidiNotes';
import { detectChordWindows } from '../../lib/midiChords';
import { midiNoteName } from '../../lib/pianoKeyboard';
import { layerColor } from '../../lib/canvasRoll.js';
import { formatTimecode } from '../../utils/formatters';
import MidiPianoRoll, { MIN_ZOOM, ZOOM_STEP, clampZoom } from './MidiPianoRoll.jsx';

// Chrome around <MidiPianoRoll>: loads + parses the .mid (useMidiNotes),
// detects chords, and wraps the roll in a collapsible panel with a toolbar
// (zoom/fit/chords/download) and a QA stats footer. Shared by the Rounds
// ReferenceAnalysis and Music Video surfaces — mount this, never a second
// copy of the roll wiring.

const COMPACT_H = 200;
const EXPANDED_H = 380;

// Chord windows keyed by the parsed view-model's identity: useMidiNotes caches
// view-models per URL, so a collapse/expand remount reuses the same object and
// skips the re-sweep — the chord cache rides the parse cache's lifetime.
const chordCache = new WeakMap();
const chordsFor = (data) => {
  if (!data) return [];
  let chords = chordCache.get(data);
  if (!chords) {
    chords = detectChordWindows(data.notes);
    chordCache.set(data, chords);
  }
  return chords;
};

/**
 * @param {object} props
 * @param {string} props.url — resolved URL of the transcribed .mid file.
 * @param {string} [props.filename] — download name for the MIDI link.
 * @param {string} [props.model] — MuScriptor model label for the footer.
 */
export default function MidiVisualization({ url, filename, model }) {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [showChords, setShowChords] = useState(true);
  const { status, data, error, reload } = useMidiNotes(open ? url : null);

  const chords = useMemo(() => chordsFor(data), [data]);

  if (!url) return null;

  const multiTrack = (data?.tracks?.length || 0) > 1;
  const density = data && data.durationSec > 0 ? data.notes.length / data.durationSec : 0;
  const densityLabel = density > 8 ? 'dense polyphony' : density > 3 ? 'moderate density' : 'sparse';

  return (
    <div className="w-full rounded-lg border border-port-border bg-port-card/50">
      <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Collapse MIDI visualization' : 'Expand MIDI visualization'}
          className="flex items-center gap-1 text-xs text-gray-300 hover:text-white"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <span className="font-medium">MIDI</span>
        </button>
        {open && (
          <>
            <span className="mx-1 h-4 w-px bg-port-border" aria-hidden="true" />
            <button type="button" onClick={() => setZoom((z) => clampZoom(z / ZOOM_STEP))} aria-label="Zoom out"
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50" title="Zoom out (-)">
              <ZoomOut size={13} />
            </button>
            <button type="button" onClick={() => setZoom((z) => clampZoom(z * ZOOM_STEP))} aria-label="Zoom in"
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50" title="Zoom in (+)">
              <ZoomIn size={13} />
            </button>
            <button type="button" onClick={() => setZoom(MIN_ZOOM)} aria-label="Fit to width"
              className="px-1.5 py-0.5 text-[10px] rounded border border-port-border text-gray-400 hover:text-white" title="Fit the whole file (0)">
              Fit
            </button>
            {chords.length > 0 && (
              <button
                type="button"
                onClick={() => setShowChords((v) => !v)}
                aria-pressed={showChords}
                className={`px-1.5 py-0.5 text-[10px] rounded border ${showChords ? 'border-port-accent text-port-accent' : 'border-port-border text-gray-400 hover:text-white'}`}
                title="Toggle the chord lane"
              >
                Chords
              </button>
            )}
            <span className="flex-1" />
            <button type="button" onClick={() => setExpanded((v) => !v)}
              aria-label={expanded ? 'Compact height' : 'Expanded height'}
              className="p-1 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
              title={expanded ? 'Compact height' : 'Expanded height'}>
              {expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>
            <a href={url} download={filename || true} aria-label="Download MIDI file"
              className="p-1 rounded text-port-accent hover:bg-port-border/50" title="Download the .mid file">
              <Download size={13} />
            </a>
          </>
        )}
      </div>
      {open && (
        <div className="px-2 pb-2">
          {(status === 'loading' || status === 'error') && (
            <div
              className={`flex items-center justify-center gap-2 rounded-lg bg-[#0c0c0e] text-xs ${status === 'error' ? 'text-port-error' : 'text-gray-400'}`}
              style={{ height: COMPACT_H }}
            >
              {status === 'loading' ? (
                <><Loader2 size={14} className="animate-spin" /> Parsing MIDI…</>
              ) : (
                <>
                  <span>{error}</span>
                  <button type="button" onClick={reload} className="px-1.5 py-0.5 rounded border border-port-border text-gray-300 hover:text-white">
                    Retry
                  </button>
                </>
              )}
            </div>
          )}
          {status === 'ready' && data && (
            <>
              <MidiPianoRoll
                data={data}
                chords={chords}
                showChords={showChords}
                zoom={zoom}
                onZoomChange={setZoom}
                height={expanded ? EXPANDED_H : COMPACT_H}
              />
              <p className="sr-only">
                MIDI transcription: {data.notes.length} notes across {data.tracks.length} track{data.tracks.length === 1 ? '' : 's'},
                pitch range {midiNoteName(data.minMidi)} to {midiNoteName(data.maxMidi)}, duration {formatTimecode(data.durationSec)}.
                {chords.length > 0 && ` Detected chords include ${chords.slice(0, 8).map((c) => c.label).join(', ')}.`}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-port-text-muted">
                <span>{`${data.notes.length} notes · ${densityLabel}`}</span>
                <span>{`${midiNoteName(data.minMidi)}–${midiNoteName(data.maxMidi)}`}</span>
                <span>{formatTimecode(data.durationSec)}</span>
                {data.tempos.length > 0 && <span>{`${data.tempos[0].bpm} BPM`}</span>}
                {model && <span>{`MuScriptor ${model}`}</span>}
                {multiTrack && (
                  <span className="flex items-center gap-1.5">
                    {data.tracks.map((t) => (
                      <span key={t.index} className="flex items-center gap-0.5">
                        <span className="inline-block w-2 h-2 rounded-sm" style={{ background: layerColor(t.index) }} aria-hidden="true" />
                        {t.name || `Track ${t.index}`}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
