/**
 * ColorMatch — sing the written melody and watch the score grade you in real
 * time. While a vocal take is recording, the parent (`SongRecordings`) walks the
 * notated score in tempo (after a one-bar metronome count-in) and feeds this
 * panel the per-note grades; it colors each notehead by how accurately it was
 * sung — green (in tune), yellow (close), red (off or missed) — then shows a
 * per-take accuracy score for training.
 *
 * Presentational: the grading lives in `useColorMatch`, lifted into
 * `SongRecordings` so the recorder can attach the finished take's pitch trace +
 * accuracy to the saved recording (#1092). This component only paints the
 * `noteColors`/`summary` it's handed onto the pure <ScoreSheet> renderer. With
 * no live take and no prior summary, it shows a hint to start recording.
 *
 * Colors and copy use `--port-*` theme tokens only; the layout is
 * mobile-responsive (the controls wrap above the staff).
 */

import { useMemo } from 'react';
import { Target } from 'lucide-react';
import { scoreHasMusic } from '../../lib/scoreNotation.js';
import ScoreSheet from './ScoreSheet.jsx';

// Summary bucket → readout color token, matching the notehead grades.
const BUCKET_TONE = {
  'in-tune': 'text-port-success',
  close: 'text-port-warning',
  off: 'text-port-error',
  missed: 'text-port-error',
};

export default function ColorMatch({
  score = '',
  stream = null,
  running = false,
  countingIn = false,
  noteColors = null,
  summary = null,
  activeIndex = null,
}) {
  const hasMusic = useMemo(() => scoreHasMusic(score), [score]);

  if (!hasMusic) return null;

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-3">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Target size={15} className="text-port-accent" /> Color-match
          {countingIn && <span className="text-xs font-normal text-port-warning">● counting in…</span>}
          {running && !countingIn && <span className="text-xs font-normal text-port-error">● grading</span>}
        </h3>
        {summary && !running && (
          <span className="text-xs text-gray-300" aria-live="polite">
            <span className={`font-semibold ${summary.percentInTune >= 80 ? 'text-port-success' : summary.percentInTune >= 50 ? 'text-port-warning' : 'text-port-error'}`}>
              {summary.percentInTune}%
            </span>{' '}
            in tune
            <span className="text-gray-500"> · {summary.graded} {summary.graded === 1 ? 'note' : 'notes'} sung</span>
          </span>
        )}
      </div>

      {!stream && !summary && (
        <p className="text-xs text-gray-500 mb-2">
          Press “Record take” above and sing along — each note lights up green, yellow, or red as you hit it.
        </p>
      )}

      <ScoreSheet text={score} controls={false} noteColors={noteColors} activeNoteIndex={activeIndex} />

      {summary && !running && summary.graded > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-xs">
          {['in-tune', 'close', 'off', 'missed'].map((b) => (
            summary.counts[b] > 0 && (
              <span key={b} className={BUCKET_TONE[b]}>
                {summary.counts[b]} {b === 'in-tune' ? 'in tune' : b}
              </span>
            )
          ))}
        </div>
      )}
    </section>
  );
}
