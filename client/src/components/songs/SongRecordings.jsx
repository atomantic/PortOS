/**
 * SongRecordings — record, save, and layer-play vocal takes for one song.
 *
 * Records mic audio via the shared audioRecorder (→ 16 kHz mono WAV base64),
 * uploads it through /api/uploads, and stores the returned filename on the song
 * as a `recordings[]` entry (persisted by the parent's Save). Multiple takes
 * play back simultaneously through createLayeredPlayer so the user can stack a
 * lead + bass + harmony and rehearse against themselves.
 *
 * Stateless about persistence: it calls up to the parent via `onChange` with the
 * next recordings array (optimistic), and the parent owns the PUT. A freshly
 * recorded take is uploaded immediately (so the file exists) but only saved to
 * the song on the parent's Save — matching the editor's explicit-save model.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Mic, Square, Play, Trash2, Volume2, VolumeX, Loader2, Target } from 'lucide-react';
import toast from '../ui/Toast';
import { startMemoRecording } from '../../lib/audioRecorder';
import { createLayeredPlayer } from '../../lib/songPlayback';
import { uploadFile, getUploadUrl } from '../../services/api';
import { formatDurationMs } from '../../utils/formatters';
import { parseScore, scoreHasMusic } from '../../lib/scoreNotation';
import { buildColorMatchTimeline, gradesFromPerNote } from '../../lib/colorMatch';
import useColorMatch from '../../hooks/useColorMatch';
import Metronome from './Metronome';
import PitchTuner from './PitchTuner';
import ColorMatch from './ColorMatch';

// Lower bound peak amplitude — below this the take is effectively silence
// (dead mic / muted input), worth warning about before it joins the stack.
const SILENCE_PEAK = 0.01;

// In-session temp id for a take not yet persisted. MUST end in `-new-<n>` so the
// editor's stripTempId (/-new-\d+$/) blanks it on save and the server assigns a
// stable `rec-<uuid>` — otherwise a reload could re-mint the same temp id and
// collide. Counter-based; uniqueness only needs to hold within the session.
let tempSeq = 0;
const tempRecordingId = () => `rec-new-${tempSeq++}`;

export default function SongRecordings({ recordings = [], layers = [], onChange, tempo = null, score = '' }) {
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [targetLayerId, setTargetLayerId] = useState('');
  // Live mic stream while recording — passed to the tuner so it taps the SAME
  // mic (no second getUserMedia). Null whenever a take isn't in flight.
  const [liveStream, setLiveStream] = useState(null);
  const handleRef = useRef(null);   // active MediaRecorder handle
  const playerRef = useRef(null);   // active layered player

  // Live color-match grading is owned HERE (not inside <ColorMatch>) so the
  // finished take's pitch trace + accuracy can be attached to the saved
  // recording (#1092). The hook taps the SAME recording stream; ColorMatch is a
  // presentational view of its noteColors/summary.
  const hasMusic = useMemo(() => scoreHasMusic(score), [score]);
  const parsedScore = useMemo(() => parseScore(score), [score]);
  const bpm = Number.isFinite(tempo) && tempo > 0 ? tempo : null;
  const {
    running: matchRunning, countingIn, noteColors, summary, activeIndex,
    start: startMatch, stop: stopMatch,
  } = useColorMatch({ score: parsedScore, stream: liveStream, bpm });

  // True once grading has armed for the CURRENT take. The hook's accumulators
  // (trace/grades) only reset on start(), so stopMatch() returns whatever the
  // last run left behind even when no run armed for this take (e.g. the score
  // was cleared between takes). We harvest the analysis only when this take
  // actually armed grading — otherwise a no-score take would inherit the prior
  // take's pitchTrack/accuracy. Reset at each record start, set when arming.
  const armedThisTakeRef = useRef(false);

  // Auto-arm grading the moment a take starts (stream appears) and the score has
  // notes — mirrors the old <ColorMatch> self-arm, now lifted up. The take's
  // stopRecording explicitly stops grading to harvest the trace, so we only
  // need to start here. The hook also self-stops if the stream vanishes.
  // We mark this take "armed" ONLY when startMatch() reports it actually began a
  // run — a rest-only score makes hasMusic true but the hook bails (zero gradable
  // notes) without resetting its accumulators, so a falsely-armed take would
  // harvest the previous take's stale analysis.
  useEffect(() => {
    if (liveStream && hasMusic && !matchRunning && startMatch()) armedThisTakeRef.current = true;
    // start is stable; react only to stream/hasMusic (the arm trigger).
  }, [liveStream, hasMusic]);

  // A persisted take selected for review — repaints its saved grades onto the
  // staff from disk (no re-grading). Null when no take is being reviewed or a
  // live take is grading (the live run owns the staff then).
  const [reviewId, setReviewId] = useState(null);

  // Tear down any live player/recorder on unmount so a navigation-away can't
  // leave the mic open or audio playing into the void.
  useEffect(() => () => {
    if (playerRef.current) playerRef.current.stop();
    if (handleRef.current) handleRef.current.cancel();
  }, []);

  const layerLabel = useCallback((layerId) => {
    if (!layerId) return '';
    return layers.find((l) => l.id === layerId)?.label || layerId;
  }, [layers]);

  const startRecording = useCallback(async () => {
    setReviewId(null); // a fresh take takes over the staff from any saved-take review
    armedThisTakeRef.current = false; // until the auto-arm effect fires for THIS take
    if (playerRef.current) { playerRef.current.stop(); setPlaying(false); }
    const handle = await startMemoRecording().catch((err) => {
      toast.error(err?.message || 'Microphone access denied');
      return null;
    });
    if (!handle) return;
    handleRef.current = handle;
    setLiveStream(handle.stream || null); // feed the tuner the recording mic
    setRecording(true);
  }, []);

  const stopRecording = useCallback(async () => {
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = null;
    // Stop grading FIRST (while the analyser graph is still alive) to harvest the
    // finished take's pitch trace + accuracy summary, THEN drop the stream. Only
    // trust the harvest when grading armed for THIS take — otherwise stopMatch()
    // would return the previous take's stale accumulators (the hook only resets
    // them on start(), which a no-score take never calls). stop() also returns
    // null when unmounted.
    const armed = armedThisTakeRef.current;
    armedThisTakeRef.current = false;
    const analysis = armed ? stopMatch() : null;
    setLiveStream(null); // stream is being torn down with the take
    setRecording(false);
    setSaving(true);
    const take = await handle.stop().catch((err) => {
      toast.error(err?.message || 'Recording failed');
      return null;
    });
    if (!take) { setSaving(false); return; }
    if (take.peak < SILENCE_PEAK) {
      toast.error('That take was silent — check your microphone and try again.');
      setSaving(false);
      return;
    }
    // Upload the WAV; the returned filename is what we persist + play from.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const result = await uploadFile(take.audioBase64, `vocal-${ts}.wav`, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Failed to save recording');
      return null;
    });
    setSaving(false);
    if (!result?.filename) return;

    const entry = {
      id: tempRecordingId(),
      layerId: targetLayerId,
      label: targetLayerId ? layerLabel(targetLayerId) : 'Take',
      filename: result.filename,
      durationMs: take.durationMs || 0,
      peak: take.peak || 0,
      muted: false,
    };
    // Attach the captured pitch analysis when the take was graded against a score
    // (#1092). Only persist a trace/summary that actually has content — a take
    // sung with no score (or that graded zero notes) carries no analysis, and the
    // server omits empty fields anyway. The server re-sanitizes + bounds both.
    if (analysis?.pitchTrack?.length) entry.pitchTrack = analysis.pitchTrack;
    if (analysis?.summary?.graded > 0) entry.accuracy = analysis.summary;

    onChange([...recordings, entry]);
    toast.success('Take recorded — Save the song to keep it');
  }, [recordings, targetLayerId, layerLabel, onChange, stopMatch]);

  const removeRecording = useCallback((id) => {
    setReviewId((cur) => (cur === id ? null : cur));
    onChange(recordings.filter((r) => r.id !== id));
  }, [recordings, onChange]);

  // The take being reviewed (if it still exists and carries saved accuracy).
  const reviewTake = useMemo(
    () => recordings.find((r) => r.id === reviewId && r.accuracy?.perNote?.length) || null,
    [recordings, reviewId],
  );
  // Repaint the reviewed take's SAVED grades onto the staff — read from disk via
  // gradesFromPerNote, never re-graded from audio (the migration's purpose).
  // Alignment is positional (i-th saved grade → i-th current timeline note), so
  // editing the score's note count after recording can shift the repaint — an
  // inherent limit of the positional perNote shape (#1027); gradesFromPerNote
  // truncates to the shorter side so it can't paint past the staff.
  const reviewColors = useMemo(() => {
    if (!reviewTake) return null;
    const timeline = buildColorMatchTimeline(parsedScore, { bpm });
    return gradesFromPerNote(timeline, reviewTake.accuracy.perNote);
  }, [reviewTake, parsedScore, bpm]);

  const toggleReview = useCallback((id) => {
    setReviewId((cur) => (cur === id ? null : id));
  }, []);

  const toggleMute = useCallback((id) => {
    onChange(recordings.map((r) => (r.id === id ? { ...r, muted: !r.muted } : r)));
  }, [recordings, onChange]);

  const assignLayer = useCallback((id, layerId) => {
    onChange(recordings.map((r) => (r.id === id
      ? { ...r, layerId, label: layerId ? layerLabel(layerId) : (r.label || 'Take') }
      : r)));
  }, [recordings, layerLabel, onChange]);

  const playAll = useCallback(async () => {
    if (playerRef.current) playerRef.current.stop();
    const takes = recordings.map((r) => ({ id: r.id, url: getUploadUrl(r.filename), muted: r.muted }));
    if (takes.every((t) => t.muted)) { toast.error('All takes are muted'); return; }
    const player = createLayeredPlayer(takes);
    player.onEnded(() => setPlaying(false));
    playerRef.current = player;
    setPlaying(true);
    await player.play().catch((err) => {
      toast.error(err?.message || 'Playback failed');
      setPlaying(false);
    });
  }, [recordings]);

  const stopPlay = useCallback(() => {
    if (playerRef.current) playerRef.current.stop();
    setPlaying(false);
  }, []);

  const audibleCount = useMemo(() => recordings.filter((r) => !r.muted).length, [recordings]);

  return (
    <section>
      <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Mic size={15} className="text-port-accent" /> Vocal takes
        </h2>
        <div className="flex items-center gap-2">
          {recordings.length > 0 && (
            playing ? (
              <button type="button" onClick={stopPlay} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50">
                <Square size={14} /> Stop
              </button>
            ) : (
              <button type="button" onClick={playAll} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50" title="Play all unmuted takes together">
                <Play size={14} /> Play layered ({audibleCount})
              </button>
            )
          )}
          {recording ? (
            <button type="button" onClick={stopRecording} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-error text-white hover:bg-port-error/90 animate-pulse">
              <Square size={14} /> Stop & save
            </button>
          ) : (
            <button type="button" onClick={startRecording} disabled={saving} className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90 disabled:opacity-50">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Mic size={14} />}
              {saving ? 'Saving…' : 'Record take'}
            </button>
          )}
        </div>
      </div>

      <p className="text-xs text-gray-500 mb-2">
        Record each part, then “Play layered” to stack them — sing along to build harmony against yourself.
        {recording && <span className="text-port-error"> ● Recording… sing now.</span>}
      </p>

      {/* Tempo reference + count-in — the shared timing grid for recording. */}
      <div className="mb-3 grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Metronome tempo={tempo} score={score} />
        {/* Live tuner — taps the recording mic while a take is live, else offers
            a standalone "just tune" mode that opens its own mic. */}
        <PitchTuner stream={liveStream} />
      </div>

      {/* Color-match — walks the written score in tempo while recording and
          grades each note by sung accuracy. While a live take grades, it shows
          the live run; otherwise it can replay a saved take's grading (selected
          via the "Review" button on a recording). Only shows when the song has a
          notated melody to sing against. */}
      <div className="mb-3">
        <ColorMatch
          score={score}
          stream={liveStream}
          running={matchRunning}
          countingIn={countingIn}
          noteColors={reviewTake && !matchRunning ? reviewColors : noteColors}
          summary={reviewTake && !matchRunning ? reviewTake.accuracy : summary}
          activeIndex={matchRunning ? activeIndex : null}
        />
      </div>

      {/* Layer the next take targets (optional) */}
      {layers.length > 0 && !recording && (
        <div className="mb-3">
          <label htmlFor="rec-target-layer" className="block text-xs text-gray-400 mb-1">Next take is for layer</label>
          <select
            id="rec-target-layer"
            value={targetLayerId}
            onChange={(e) => setTargetLayerId(e.target.value)}
            className="w-full sm:w-64 bg-port-bg border border-port-border rounded-lg px-3 py-1.5 text-sm text-white focus:border-port-accent focus:outline-none"
          >
            <option value="">— Unassigned —</option>
            {layers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </div>
      )}

      {recordings.length === 0 ? (
        <p className="text-xs text-gray-500">No takes yet. Record the lead first, then layer in harmonies.</p>
      ) : (
        <ul className="space-y-2">
          {recordings.map((r) => (
            <li key={r.id} className={`bg-port-card border rounded-lg flex items-center gap-2 px-3 py-2 ${r.muted ? 'border-port-border opacity-60' : 'border-port-border'}`}>
              <button
                type="button"
                onClick={() => toggleMute(r.id)}
                className={`p-1 shrink-0 ${r.muted ? 'text-gray-600 hover:text-gray-400' : 'text-port-accent hover:text-port-accent/80'}`}
                aria-label={r.muted ? 'Unmute take' : 'Mute take'}
                title={r.muted ? 'Muted — excluded from layered play' : 'Audible in layered play'}
              >
                {r.muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
              </button>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm text-white truncate">{r.label || 'Take'}</span>
                  {r.durationMs > 0 && <span className="text-xs text-gray-500 shrink-0">{formatDurationMs(r.durationMs)}</span>}
                  {r.accuracy?.graded > 0 && (
                    <span
                      className={`text-xs shrink-0 font-medium ${r.accuracy.percentInTune >= 80 ? 'text-port-success' : r.accuracy.percentInTune >= 50 ? 'text-port-warning' : 'text-port-error'}`}
                      title={`${r.accuracy.percentInTune}% in tune over ${r.accuracy.graded} ${r.accuracy.graded === 1 ? 'note' : 'notes'}`}
                    >
                      {r.accuracy.percentInTune}%
                    </span>
                  )}
                </div>
                {layers.length > 0 && (
                  <select
                    value={r.layerId || ''}
                    onChange={(e) => assignLayer(r.id, e.target.value)}
                    aria-label="Assign take to layer"
                    className="mt-1 bg-port-bg border border-port-border rounded px-2 py-0.5 text-xs text-gray-300 focus:border-port-accent focus:outline-none"
                  >
                    <option value="">— Unassigned —</option>
                    {layers.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                )}
              </div>
              {/* Review the saved grading on the staff (no re-grading from audio).
                  Only when the take carries per-note grades and nothing is live. */}
              {hasMusic && r.accuracy?.perNote?.length > 0 && !matchRunning && (
                <button
                  type="button"
                  onClick={() => toggleReview(r.id)}
                  aria-pressed={reviewId === r.id}
                  title={reviewId === r.id ? 'Hide saved grading' : 'Show this take’s grading on the staff'}
                  className={`p-1 shrink-0 ${reviewId === r.id ? 'text-port-accent' : 'text-gray-500 hover:text-port-accent'}`}
                  aria-label="Review take grading"
                >
                  <Target size={15} />
                </button>
              )}
              {/* Solo listen to one take */}
              <audio controls preload="none" src={getUploadUrl(r.filename)} className="h-8 max-w-[160px] hidden sm:block" />
              <button type="button" onClick={() => removeRecording(r.id)} className="p-1.5 text-gray-500 hover:text-port-error shrink-0" aria-label="Remove take">
                <Trash2 size={15} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
