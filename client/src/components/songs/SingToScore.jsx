/**
 * SingToScore — sing a melody and draw the detected notes into the score editor.
 *
 * Workflow: press "Sing", get a one-bar count-in on the metronome (so you know
 * where beat 1 is), sing the phrase, press "Stop". The hook captures a pitch
 * track off the mic, segments it into notes, quantizes the durations to the song
 * tempo, spells the notes for the key, and emits lead-sheet notation. The result
 * renders in a live <ScoreSheet> preview (the same parser→renderer round-trip the
 * editor uses) so you can confirm it before inserting it — appended to the end of
 * the score, or replacing the current textarea selection.
 *
 * No notation/DSP library: it composes the existing pitch-detection core, the
 * metronome, the lead-sheet parser, and the ScoreSheet renderer.
 */

import { useMemo } from 'react';
import { Mic, Square, Plus, Replace, X } from 'lucide-react';
import ScoreSheet from './ScoreSheet.jsx';
import useSingToScore, { SING_IDLE, SING_COUNT_IN, SING_RECORDING } from '../../hooks/useSingToScore.js';
import { parseScore } from '../../lib/scoreNotation.js';

export default function SingToScore({ value = '', tempo = null, musicKey = 'C', hasSelection = false, onInsert }) {
  const { phase, beat, result, error, start, stop, reset } = useSingToScore({ tempo, score: value, musicKey });

  // The result is just the measure body; render it under the score's own header
  // (clef/key/time/tempo) so the preview staff matches what the inserted notes
  // will look like in context.
  const previewText = useMemo(() => {
    if (!result) return '';
    const parsed = parseScore(value || '');
    const header = [
      `clef: ${parsed.clef}`,
      `key: ${parsed.key}`,
      `time: ${parsed.time.beats}/${parsed.time.beatValue}`,
      parsed.tempo != null ? `tempo: ${parsed.tempo}` : null,
    ].filter(Boolean).join('\n');
    return `${header}\n\n${result}`;
  }, [result, value]);

  const previewHasMusic = useMemo(
    () => (previewText ? parseScore(previewText).measures.some((m) => m.notes.length > 0) : false),
    [previewText],
  );

  const recording = phase !== SING_IDLE;

  const insert = (mode) => {
    if (!result) return;
    onInsert?.(result, mode);
    reset();
  };

  return (
    <div className="bg-port-card border border-port-border rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Mic size={15} className="text-port-accent" /> Sing to score
          {phase === SING_COUNT_IN && <span className="text-xs font-normal text-port-warning">● count-in {beat ?? ''}</span>}
          {phase === SING_RECORDING && <span className="text-xs font-normal text-port-error">● singing… beat {beat ?? ''}</span>}
        </h3>
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
            onClick={start}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90"
            title="Count in, then sing a phrase — the notes are transcribed for review"
          >
            <Mic size={14} /> Sing
          </button>
        )}
      </div>

      <p className="text-xs text-gray-500 mt-2">
        {recording
          ? phase === SING_COUNT_IN
            ? 'Counting you in — start on beat 1.'
            : 'Sing your melody now, then press Stop.'
          : 'Records a melody and transcribes it at the song tempo. Review the staff below before inserting.'}
      </p>

      {error && <p className="mt-2 text-xs text-port-error">{error}</p>}

      {/* Transcribed result — live preview + insert controls. */}
      {result != null && !recording && (
        result && previewHasMusic ? (
          <div className="mt-3 space-y-2">
            <div className="bg-port-bg border border-port-border rounded-lg p-3 overflow-x-auto">
              <ScoreSheet text={previewText} />
            </div>
            <pre className="text-xs text-gray-400 font-mono whitespace-pre-wrap break-words bg-port-bg border border-port-border rounded-lg p-2">{result}</pre>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => insert('append')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90"
              >
                <Plus size={14} /> Append to score
              </button>
              <button
                type="button"
                onClick={() => insert('replace')}
                disabled={!hasSelection}
                title={hasSelection ? 'Replace the selected notation' : 'Select text in the editor to replace it'}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50 disabled:opacity-40"
              >
                <Replace size={14} /> Replace selection
              </button>
              <button
                type="button"
                onClick={reset}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg text-gray-400 hover:text-white"
              >
                <X size={14} /> Discard
              </button>
            </div>
          </div>
        ) : (
          <p className="mt-3 text-xs text-port-warning">
            No clear notes detected — sing a bit louder and steadier, then try again.
          </p>
        )
      )}
    </div>
  );
}
