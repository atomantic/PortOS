import { useEffect, useMemo, useState } from 'react';
import { Check, Mic, RotateCcw, Square } from 'lucide-react';
import useSingToVerify, {
  VERIFY_COUNT_IN,
  VERIFY_IDLE,
  VERIFY_RECORDING,
} from '../../hooks/useSingToVerify.js';
import { GRADE } from '../../lib/colorMatch.js';
import { parseScore, replaceNotePitch } from '../../lib/scoreNotation.js';
import MicProcessingHint from './MicProcessingHint.jsx';
import ScoreSheet from './ScoreSheet.jsx';

const pitchLabel = (pitch) =>
  pitch ? `${pitch.letter}${pitch.accidental || ''}${pitch.octave}` : '—';

export default function SingToVerify({ value = '', tempo = null, onChange }) {
  const score = useMemo(() => parseScore(value), [value]);
  const [startBar, setStartBar] = useState(1);
  const [activeIndex, setActiveIndex] = useState(null);
  const {
    phase,
    beat,
    rows,
    error,
    micProcessing,
    start,
    stop,
    cancel,
    reset,
    toggleAccept,
    acceptAll,
  } = useSingToVerify({ score: value, tempo });

  const recording = phase !== VERIFY_IDLE;
  const measureCount = Math.max(1, score.measures.length);
  const noteColors = useMemo(
    () => Object.fromEntries(rows
      .filter((row) => row.grade !== GRADE.PENDING)
      .map((row) => [row.index, row.grade])),
    [rows],
  );
  const acceptedCount = rows.filter((row) => row.accepted && row.sung).length;

  // Parsed source spans belong to the exact score text captured. If the user
  // edits the textarea before committing, discard the stale comparison instead
  // of letting it target a different token.
  useEffect(() => {
    cancel();
    reset();
    setActiveIndex(null);
  }, [value, cancel, reset]);

  const commit = () => {
    const accepted = rows
      .filter((row) => row.accepted && row.sung)
      .sort((a, b) => b.note.start - a.note.start);
    if (!accepted.length) return;
    const next = accepted.reduce(
      (text, row) => replaceNotePitch(text, row.note, pitchLabel(row.sung)),
      value,
    );
    onChange?.(next);
    reset();
    setActiveIndex(null);
  };

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
            <Mic size={15} className="text-port-accent" /> Sing to verify
            {phase === VERIFY_COUNT_IN && (
              <span className="text-xs font-normal text-port-warning">● count-in {beat ?? ''}</span>
            )}
            {phase === VERIFY_RECORDING && (
              <span className="text-xs font-normal text-port-error">● singing… beat {beat ?? ''}</span>
            )}
          </h3>
          <p className="text-xs text-gray-500 mt-1">
            Sing the written melody, compare each pitch, then choose which sung notes become part of the score.
          </p>
        </div>

        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label htmlFor="sing-to-verify-start-bar" className="block text-xs text-gray-400 mb-1">
              Start bar
            </label>
            <select
              id="sing-to-verify-start-bar"
              value={Math.min(startBar, measureCount)}
              onChange={(event) => setStartBar(Number(event.target.value))}
              disabled={recording}
              className="bg-port-bg border border-port-border rounded-lg px-2.5 py-1.5 text-xs text-white focus:border-port-accent focus:outline-none disabled:opacity-50"
            >
              {Array.from({ length: measureCount }, (_, index) => (
                <option key={index + 1} value={index + 1}>Bar {index + 1}</option>
              ))}
            </select>
          </div>
          {recording ? (
            <button
              type="button"
              onClick={stop}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-error text-white hover:bg-port-error/90"
            >
              <Square size={14} /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => start(startBar)}
              disabled={!score.measures.some((measure) => measure.notes.some((note) => !note.rest))}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-40"
            >
              <Mic size={14} /> Sing
            </button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-port-error">{error}</p>}
      <MicProcessingHint processing={micProcessing} />

      {rows.length > 0 && !recording && (
        <div className="mt-3 space-y-3">
          <div className="bg-port-bg border border-port-border rounded-lg p-3 overflow-x-auto">
            <ScoreSheet
              text={value}
              controls={false}
              noteColors={noteColors}
              activeNoteIndex={activeIndex}
            />
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-xs text-gray-400">
              {acceptedCount} of {rows.filter((row) => row.sung).length} detected notes accepted
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={acceptAll}
                disabled={!rows.some((row) => row.sung)}
                className="px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white disabled:opacity-40"
              >
                Accept all sung
              </button>
              <button
                type="button"
                onClick={commit}
                disabled={acceptedCount === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-40"
              >
                <Check size={14} /> Commit accepted notes
              </button>
              <button
                type="button"
                onClick={() => { reset(); setActiveIndex(null); }}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg text-gray-400 hover:text-white"
              >
                <RotateCcw size={14} /> Reset
              </button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            {rows.map((row) => {
              const canAccept = !!row.sung;
              const cents = row.cents == null ? 'no clear pitch' : `${row.cents >= 0 ? '+' : ''}${Math.round(row.cents)}¢`;
              return (
                <div
                  key={row.index}
                  className={`flex items-center justify-between gap-3 rounded-lg border p-2.5 ${
                    activeIndex === row.index ? 'border-port-accent bg-port-accent/10' : 'border-port-border bg-port-bg'
                  }`}
                  onMouseEnter={() => setActiveIndex(row.index)}
                  onFocus={() => setActiveIndex(row.index)}
                >
                  <button
                    type="button"
                    onClick={() => setActiveIndex(row.index)}
                    className="min-w-0 text-left"
                  >
                    <span className="block text-sm text-white">
                      {pitchLabel(row.written)} <span className="text-gray-500">→</span> {pitchLabel(row.sung)}
                    </span>
                    <span className="block text-xs text-gray-500">{cents} · {row.grade}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleAccept(row.index)}
                    disabled={!canAccept}
                    aria-pressed={row.accepted}
                    className={`shrink-0 px-2.5 py-1.5 text-xs rounded-lg border disabled:opacity-40 ${
                      row.accepted
                        ? 'border-port-accent bg-port-accent text-white'
                        : 'border-port-border text-gray-300 hover:text-white'
                    }`}
                  >
                    {row.accepted ? 'Keep written' : 'Accept sung'}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
