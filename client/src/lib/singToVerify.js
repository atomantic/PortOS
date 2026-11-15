// Pure sing-to-verify alignment. It maps a captured vocal pitch track onto the
// written score's existing note windows, producing a strict 1:1 pitch diff.
//
// Pure strict-1:1 score verification: `alignSingToVerify(score, track, { bpm, startBar, captureEndMs
// })` aligns clear sung-pitch frames to `buildColorMatchTimeline` windows, preserves detected octave
// and key-aware spelling, and returns written→sung rows with raw cents, grade, source note, and
// explicit acceptance state. Reached silent windows are `missed`; notes after Stop remain `pending`.

import {
  buildColorMatchTimeline,
  centsBetween,
  GRADE,
  MATCH_CLOSE_CENTS,
  MATCH_IN_TUNE_CENTS,
} from './colorMatch.js';
import { frequencyToNote } from './pitchDetect.js';
import { spellNote } from './singToScore.js';

const DEFAULT_CLARITY = 0.9;

const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const pitchShape = (pitch) => pitch && ({
  letter: pitch.letter,
  accidental: pitch.accidental || '',
  octave: pitch.octave,
});

const gradeRawCents = (cents) => {
  if (cents == null) return GRADE.MISSED;
  const distance = Math.abs(cents);
  if (distance <= MATCH_IN_TUNE_CENTS) return GRADE.IN_TUNE;
  if (distance <= MATCH_CLOSE_CENTS) return GRADE.CLOSE;
  return GRADE.OFF;
};

/**
 * Align captured pitch frames to written notes from `startBar` onward.
 *
 * `captureEndMs` distinguishes a silent-but-reached window (`missed`) from a
 * note after Stop (`pending`). It defaults to the final frame timestamp.
 */
export const alignSingToVerify = (
  score,
  track,
  {
    bpm,
    startBar = 1,
    captureEndMs,
    clarityThreshold = DEFAULT_CLARITY,
  } = {},
) => {
  const measures = score?.measures || [];
  const safeStartBar = Math.min(Math.max(1, Number(startBar) || 1), Math.max(1, measures.length));
  const allNotes = measures.flatMap((measure) => measure.notes || []);
  const startIndex = measures
    .slice(0, safeStartBar - 1)
    .reduce((count, measure) => count + (measure.notes?.length || 0), 0);
  const timeline = buildColorMatchTimeline(score, { bpm });
  const firstWindow = timeline.notes.find((note) => note.index >= startIndex);
  if (!firstWindow) return [];

  const frames = Array.isArray(track)
    ? track.filter((frame) => frame && Number.isFinite(frame.tMs))
    : [];
  const resolvedEnd = Number.isFinite(captureEndMs)
    ? Math.max(0, captureEndMs)
    : Math.max(0, ...frames.map((frame) => frame.tMs));
  // Capture starts on beat 1 of the selected bar, not on its first pitched
  // note. Leading rests in that bar must retain their full waiting time.
  const offsetMs = measures
    .slice(0, safeStartBar - 1)
    .reduce((duration, measure) => duration + (measure.beats || 0), 0)
    * timeline.msPerQuarter;

  return timeline.notes
    .filter((window) => window.index >= startIndex)
    .map((window) => {
      const note = allNotes[window.index];
      const startMs = window.startMs - offsetMs;
      const endMs = window.endMs - offsetMs;
      if (startMs >= resolvedEnd) {
        return {
          index: window.index,
          note,
          written: pitchShape(note?.pitch),
          sung: null,
          cents: null,
          grade: GRADE.PENDING,
          accepted: false,
        };
      }

      const hz = median(frames
        .filter((frame) =>
          frame.tMs >= startMs
          && frame.tMs < endMs
          && Number.isFinite(frame.hz)
          && frame.hz > 0
          && (frame.clarity ?? 1) >= clarityThreshold)
        .map((frame) => frame.hz));
      const detected = hz == null ? null : spellNote(frequencyToNote(hz), score?.keySig);
      const cents = centsBetween(hz, window.targetHz);
      return {
        index: window.index,
        note,
        written: pitchShape(note?.pitch),
        sung: pitchShape(detected),
        cents,
        grade: gradeRawCents(cents),
        accepted: false,
      };
    });
};
