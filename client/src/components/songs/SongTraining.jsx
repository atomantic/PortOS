/**
 * SongTraining — the practice loop that ties the song system together into a
 * memorize / learn / track tool (#1028, the capstone of the #1021 umbrella).
 *
 * Pick a target (the whole song or one section), press Start, get counted in on
 * the metronome, sing the part, and watch the staff grade you note-by-note
 * (green / yellow / red) with an accuracy score — then repeat. Loop a single
 * section to drill it, or loop the whole song. As your rolling average on a
 * scope climbs, the lyrics fade and finally hide so you're singing from memory.
 * A progress panel shows which sections are learned, your best/average per
 * scope, and nudges you toward the weakest sections (spaced repetition).
 *
 * It is a thin shell over `useSongTraining` (which reuses the color-match timing
 * + grading loop) and the pure `songProgress` core (sections, history, stats).
 * It owns its OWN mic — training is a deliberate practice action separate from
 * "record a take", and nothing is saved as a recording — and reports progress up
 * to the parent via `onProgress` (persisted on the song's Save, like takes).
 *
 * Colors/copy use `--port-*` tokens only; the layout is mobile-responsive.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GraduationCap, Play, Square, Repeat, CheckCircle2, Circle, Target } from 'lucide-react';
import toast from '../ui/Toast';
import { scoreHasMusic } from '../../lib/scoreNotation.js';
import {
  WHOLE_SONG_SCOPE,
  deriveTrainingSections,
  scopeStats,
  wholeSongStats,
  weakestSections,
  memorizationPercent,
  hideLevelFor,
} from '../../lib/songProgress.js';
import useSongTraining from '../../hooks/useSongTraining.js';
import useMounted from '../../hooks/useMounted.js';
import ScoreSheet from './ScoreSheet.jsx';

// Accuracy % → readout tone. Mirrors the color-match summary coloring.
const percentTone = (pct) => (pct >= 80 ? 'text-port-success' : pct >= 50 ? 'text-port-warning' : 'text-port-error');

export default function SongTraining({
  score = '',
  lyricSections = [],
  tempo = null,
  progress = null,
  onProgress,
}) {
  const hasMusic = useMemo(() => scoreHasMusic(score), [score]);
  const sections = useMemo(() => deriveTrainingSections(score, lyricSections), [score, lyricSections]);

  // Which scope is selected for the next run: WHOLE_SONG_SCOPE or a section id.
  const [scopeId, setScopeId] = useState(WHOLE_SONG_SCOPE);
  const [loop, setLoop] = useState(false);

  // Keep the selected scope valid as the score changes (a section can vanish on
  // an edit) — fall back to the whole song.
  useEffect(() => {
    if (scopeId !== WHOLE_SONG_SCOPE && !sections.some((s) => s.id === scopeId)) {
      setScopeId(WHOLE_SONG_SCOPE);
    }
  }, [sections, scopeId]);

  const activeScope = useMemo(
    () => (scopeId === WHOLE_SONG_SCOPE
      ? { id: WHOLE_SONG_SCOPE, label: 'Whole song', score }
      : sections.find((s) => s.id === scopeId) || { id: WHOLE_SONG_SCOPE, label: 'Whole song', score }),
    [scopeId, sections, score],
  );

  // The training mic — opened on Start, closed on Stop / unmount. Training is a
  // deliberate practice action, so it owns its own getUserMedia (separate from
  // the take recorder), and nothing it captures is persisted as audio.
  const [stream, setStream] = useState(null);
  const streamRef = useRef(null);
  const mountedRef = useMounted();

  const {
    running, countingIn, noteColors, activeIndex, lastSummary, start, stop,
  } = useSongTraining({
    scopeId: activeScope.id,
    scopeScore: activeScope.score,
    stream,
    tempo,
    loop,
    progress,
    onProgress,
  });

  const closeMic = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setStream(null);
  }, []);

  // Stop a session: end the training loop, then close the mic.
  const handleStop = useCallback(() => {
    stop();
    closeMic();
  }, [stop, closeMic]);

  const handleStart = useCallback(async () => {
    if (running || stream) return;
    const src = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((err) => {
      toast.error(err?.message || 'Microphone access denied');
      return null;
    });
    if (!src) return;
    if (!mountedRef.current) { src.getTracks().forEach((t) => t.stop()); return; }
    streamRef.current = src;
    setStream(src);
  }, [running, stream, mountedRef]);

  // Once the mic stream lands (after Start), arm the training run for the scope.
  useEffect(() => {
    if (stream && !running && hasMusic && activeScope.score) start();
    // start is stable from the hook; only react to the stream arriving.
  }, [stream]);

  // When a run finishes NATURALLY and we're not looping, close the mic and drop
  // out of the Stop state — otherwise the mic stays open (and the UI stuck on
  // Stop) until the user clicks Stop by hand. Looping keeps the mic open across
  // the relaunch gap; an armed-but-not-yet-started run (stream just landed,
  // `start()` pending) is gated by `armedRef` so this can't close the mic before
  // the first run even begins.
  const armedRef = useRef(false);
  useEffect(() => { if (running) armedRef.current = true; }, [running]);
  useEffect(() => {
    if (armedRef.current && !running && !loop) {
      armedRef.current = false;
      closeMic();
    }
  }, [running, loop, closeMic]);

  // Tear the mic down on unmount.
  useEffect(() => () => {
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
  }, []);

  // Derived progress views — recomputed from the (immutable) progress aggregate.
  const wholeStats = useMemo(() => wholeSongStats(progress), [progress]);
  const overall = useMemo(() => memorizationPercent(progress, sections), [progress, sections]);
  const weak = useMemo(() => weakestSections(progress, sections).slice(0, 3), [progress, sections]);

  // Progressive hiding for the staff lyrics, driven by the active scope's
  // rolling average so a single good take doesn't yank the crutch mid-drill.
  const scopeAvg = useMemo(
    () => scopeStats(progress, activeScope.id).average,
    [progress, activeScope.id],
  );
  const hideLevel = hideLevelFor(scopeAvg);
  const showLyrics = hideLevel === 'show' || hideLevel === 'dim';
  const showNotes = hideLevel !== 'blind';
  const dimLyrics = hideLevel === 'dim';

  if (!hasMusic) {
    return (
      <section className="bg-port-card border border-port-border rounded-lg p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white mb-2">
          <GraduationCap size={15} className="text-port-accent" /> Training
        </h2>
        <p className="text-xs text-gray-500">
          Add a notated melody in the Sheet music tab to practice against it — training grades you note by note and tracks what you&apos;ve learned.
        </p>
      </section>
    );
  }

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <GraduationCap size={15} className="text-port-accent" /> Training
          {countingIn && <span className="text-xs font-normal text-port-warning">● counting in…</span>}
          {running && !countingIn && <span className="text-xs font-normal text-port-error">● singing</span>}
        </h2>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setLoop((v) => !v)}
            aria-pressed={loop}
            title={loop ? 'Looping — restarts after each run' : 'Loop this scope'}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${loop ? 'bg-port-accent/15 border-port-accent/60 text-white' : 'border-port-border text-gray-300 hover:text-white hover:bg-port-border/50'}`}
          >
            <Repeat size={14} /> Loop
          </button>
          {running || stream ? (
            <button
              type="button"
              onClick={handleStop}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-error text-white hover:bg-port-error/90"
            >
              <Square size={14} /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStart}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90"
              title="Count in, then sing the selected part — you're graded note by note"
            >
              <Play size={14} /> Start
            </button>
          )}
        </div>
      </div>

      {/* Scope picker — whole song or a single section to drill. */}
      <div>
        <label htmlFor="training-scope" className="block text-xs text-gray-400 mb-1">Practice</label>
        <select
          id="training-scope"
          value={scopeId}
          onChange={(e) => setScopeId(e.target.value)}
          disabled={running || Boolean(stream)}
          className="w-full sm:w-72 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none disabled:opacity-50"
        >
          <option value={WHOLE_SONG_SCOPE}>Whole song</option>
          {sections.map((s) => (
            <option key={s.id} value={s.id}>{s.label}{s.measures ? ` (${s.measures} bars)` : ''}</option>
          ))}
        </select>
      </div>

      {/* Latest take readout. */}
      {lastSummary && (
        <p className="text-xs text-gray-300" aria-live="polite">
          Last take:{' '}
          <span className={`font-semibold ${percentTone(lastSummary.percentInTune)}`}>{lastSummary.percentInTune}%</span>{' '}
          in tune
          <span className="text-gray-500"> · {lastSummary.graded} {lastSummary.graded === 1 ? 'note' : 'notes'}</span>
        </p>
      )}

      {/* The staff with live grading. Lyrics/notes hide progressively as the
          scope's rolling average climbs (sing from memory). */}
      {showNotes ? (
        <div className={dimLyrics ? 'opacity-90' : ''}>
          <ScoreSheet
            text={activeScope.score}
            controls={false}
            noteColors={noteColors}
            activeNoteIndex={activeIndex}
            hideLyrics={!showLyrics}
          />
          {!showLyrics && (
            <p className="text-xs text-port-success mt-1">Lyrics hidden — you&apos;re singing this from memory. Nice.</p>
          )}
        </div>
      ) : (
        <p className="text-xs text-port-success py-6 text-center">
          🎉 Memorized — singing this with no chart. Press Start and sing it blind.
        </p>
      )}

      {/* Progress panel — overall completion, whole-song stats, weak sections. */}
      <div className="border-t border-port-border pt-3 space-y-3">
        <div>
          <div className="flex items-center justify-between text-xs text-gray-400 mb-1">
            <span>Memorization</span>
            <span className="text-gray-300">{overall}%</span>
          </div>
          <div className="h-2 rounded-full bg-port-bg overflow-hidden">
            <div className="h-full bg-port-success transition-all" style={{ width: `${overall}%` }} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-300">
          <span className="flex items-center gap-1.5">
            {wholeStats.learned
              ? <CheckCircle2 size={14} className="text-port-success" />
              : <Circle size={14} className="text-gray-600" />}
            Whole song
          </span>
          {wholeStats.attempts > 0 && (
            <>
              <span>best <span className={`font-semibold ${percentTone(wholeStats.best)}`}>{wholeStats.best}%</span></span>
              <span className="text-gray-500">avg {wholeStats.average}% · {wholeStats.attempts} {wholeStats.attempts === 1 ? 'take' : 'takes'}</span>
            </>
          )}
        </div>

        {sections.length > 0 && (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {sections.map((s) => {
              const st = scopeStats(progress, s.id);
              return (
                <li key={s.id} className="flex items-center justify-between gap-2 text-gray-300">
                  <span className="flex items-center gap-1.5 min-w-0">
                    {st.learned
                      ? <CheckCircle2 size={13} className="text-port-success shrink-0" />
                      : <Circle size={13} className="text-gray-600 shrink-0" />}
                    <span className="truncate">{s.label}</span>
                  </span>
                  {st.attempts > 0
                    ? <span className={`shrink-0 ${percentTone(st.average)}`}>{st.average}%</span>
                    : <span className="text-gray-600 shrink-0">—</span>}
                </li>
              );
            })}
          </ul>
        )}

        {weak.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-gray-500">
              <Target size={13} className="text-port-warning" /> Drill next:
            </span>
            {weak.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setScopeId(s.id)}
                disabled={running || Boolean(stream)}
                className="px-2.5 py-1 text-xs rounded-full border border-port-warning/40 text-gray-300 hover:text-white hover:border-port-warning disabled:opacity-40"
              >
                {s.label}{s.stats.attempts > 0 ? ` · ${s.stats.average}%` : ' · new'}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
