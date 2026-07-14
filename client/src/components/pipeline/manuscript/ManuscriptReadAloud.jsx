/**
 * Manuscript Read-Aloud — full-prose TTS proofing (#1304).
 *
 * Reading prose aloud surfaces clunky rhythm, tongue-twisters, repeated words,
 * and unnatural sentences that are invisible to the eye. This modal narrates the
 * active manuscript section with the local TTS engines (Kokoro/Piper, same path
 * as storyboard dialogue), highlighting each sentence karaoke-style as it plays.
 *
 * Sync: the server splits the prose into sentence segments and returns each
 * one's audio filename + measured duration. We play the segments back-to-back
 * via a single <audio> element and highlight the active sentence — no word-level
 * timestamps needed. Each segment also carries a "hard to say" readability scan;
 * flagged sentences get a wavy underline + tooltip so trouble-spots are visible
 * before/while listening.
 *
 * Non-destructive: narration never mutates the manuscript — it only reads the
 * section's current text.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Pause, Square, Loader2, Volume2, AlertTriangle } from 'lucide-react';
import Modal from '../../ui/Modal';
import VoicePicker from '../../voice/VoicePicker';
import toast from '../../ui/Toast';
import { formatDurationMs } from '../../../utils/formatters';
import { narratePipelineProse } from '../../../services/api';
import { STAGE_LABEL } from './constants';
import { clickableProps } from '../../../lib/a11yKeyboard';
import { safeReadStorage, safeWriteStorage } from '../../../lib/safeStorage';

const NARRATOR_VOICE_KEY = 'portos.manuscript.narratorVoice';
const initialVoice = () => safeReadStorage(NARRATOR_VOICE_KEY) || '';

export default function ManuscriptReadAloud({ open, onClose, section }) {
  const content = section?.content || '';
  const [voiceId, setVoiceId] = useState(initialVoice);
  const [segments, setSegments] = useState(null); // null = not synthesized yet
  const [loading, setLoading] = useState(false);
  // -1 = idle/no highlight; otherwise the segment currently cued.
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [isPlaying, setIsPlaying] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);

  const audioRef = useRef(null);
  // Set true on (re)mount, false on unmount. The body-set is required because
  // the app runs under React.StrictMode, which does mount→cleanup→mount on the
  // initial mount; a cleanup-only guard would be left false and freeze every
  // later narration at the mounted check.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  // Live mirror of the prose the modal is showing, so an in-flight narration
  // response can detect that the section's text changed (edit, reformat, accepted
  // fix, or a section swap) while it was synthesizing and discard itself rather
  // than apply stale audio/offsets to different prose.
  const contentRef = useRef(content);
  contentRef.current = content;
  // Live mirror of `open` so a narration that resolves after the modal was
  // closed doesn't auto-start playback into an unmounted <audio> element.
  const openRef = useRef(open);
  openRef.current = open;

  // Reset narration when the prose being read changes — a different issue/stage,
  // or the SAME section edited under it. The cached segments + their char offsets
  // belong to the exact text they were synthesized from; reusing them against
  // changed prose would misalign the highlight and play the wrong sentence.
  const resetNarration = () => {
    setSegments(null);
    setCurrentIndex(-1);
    setIsPlaying(false);
    setElapsedMs(0);
  };
  useEffect(() => { resetNarration(); }, [section?.issueId, section?.stageId, content]);
  useEffect(() => { if (!open) { setIsPlaying(false); } }, [open]);

  // Cumulative start offset (ms) per segment + total, for the progress bar.
  const { cumulative, totalMs } = useMemo(() => {
    const cum = [];
    let acc = 0;
    (segments || []).forEach((s) => { cum.push(acc); acc += s.durationMs || 0; });
    return { cumulative: cum, totalMs: acc };
  }, [segments]);

  const hardCount = useMemo(
    () => (segments || []).filter((s) => s.readability?.hard).length,
    [segments],
  );

  // Drive the <audio> element from (currentIndex, isPlaying). The src is bound
  // in JSX from currentIndex, so changing index reloads + plays from the start
  // of that segment; toggling isPlaying without an index change pauses/resumes.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (currentIndex < 0) { audio.pause(); return; }
    if (isPlaying) {
      // play() rejects when the browser's autoplay policy blocks it — e.g. the
      // user-activation window lapsed while a long section synthesized. Fall
      // back to paused so the UI shows "Play" (a click is a fresh gesture the
      // browser will honor) instead of a "Pause" button over silence.
      audio.play().catch(() => { if (mountedRef.current) setIsPlaying(false); });
    } else {
      audio.pause();
    }
  }, [currentIndex, isPlaying]);

  const runNarration = async () => {
    if (!content.trim()) {
      toast('There is no drafted prose to read aloud');
      return;
    }
    setLoading(true);
    const reqContent = content; // snapshot — discard if the prose changes mid-flight
    const result = await narratePipelineProse(content, voiceId || undefined, { silent: true })
      .catch((err) => {
        toast.error(err.message || 'Failed to narrate');
        return null;
      });
    if (!mountedRef.current) return;
    setLoading(false);
    // Drop the response if the section's text changed while it synthesized — its
    // offsets belong to `reqContent`, not the current prose.
    if (contentRef.current !== reqContent || !result) return;
    const segs = Array.isArray(result.segments) ? result.segments : [];
    setSegments(segs);
    setElapsedMs(0);
    // Only auto-start when the modal is still open — otherwise the <audio> is
    // unmounted and the play effect would set "Pause" with nothing playing. The
    // segments still load, so reopening shows the prose ready to Play.
    if (segs.length && openRef.current) { setCurrentIndex(0); setIsPlaying(true); }
  };

  const togglePlay = () => {
    if (!segments?.length) return;
    if (currentIndex < 0) { setCurrentIndex(0); setIsPlaying(true); return; }
    setIsPlaying((p) => !p);
  };

  const stop = () => {
    setIsPlaying(false);
    setCurrentIndex(-1);
    setElapsedMs(0);
    const audio = audioRef.current;
    if (audio) audio.currentTime = 0;
  };

  // Memoized on currentIndex (its only non-stable closure) so `renderedProse`
  // — which wires it onto every sentence span — stays cached between renders.
  const jumpTo = useCallback((idx) => {
    // Re-clicking the already-current sentence keeps both state values
    // unchanged, so the play effect won't re-fire and the <audio> src won't
    // reload — restart it imperatively so "play that line again" works.
    const audio = audioRef.current;
    if (idx === currentIndex && audio) {
      audio.currentTime = 0;
      audio.play().catch(() => {});
      setIsPlaying(true);
      return;
    }
    setCurrentIndex(idx);
    setIsPlaying(true);
  }, [currentIndex]);

  const onEnded = () => {
    if (currentIndex < (segments?.length || 0) - 1) {
      setCurrentIndex(currentIndex + 1);
    } else {
      setIsPlaying(false);
      setElapsedMs(totalMs);
    }
  };

  const onTimeUpdate = () => {
    const audio = audioRef.current;
    if (!audio || currentIndex < 0) return;
    setElapsedMs((cumulative[currentIndex] || 0) + audio.currentTime * 1000);
  };

  const changeVoice = (next) => {
    setVoiceId(next);
    safeWriteStorage(NARRATOR_VOICE_KEY, next || '');
    // Cached segments were synthesized with the prior voice — invalidate so the
    // next play re-synthesizes with the new narrator.
    resetNarration();
  };

  // Render the prose with each sentence wrapped in a span, preserving the exact
  // inter-sentence whitespace from the original text (the gaps between spans).
  const renderedProse = useMemo(() => {
    if (!segments?.length) return null;
    const nodes = [];
    let cursor = 0;
    segments.forEach((seg) => {
      if (seg.start > cursor) {
        nodes.push(<span key={`gap-${cursor}`}>{content.slice(cursor, seg.start)}</span>);
      }
      const active = seg.index === currentIndex;
      const reasons = seg.readability?.reasons || [];
      const hard = seg.readability?.hard;
      nodes.push(
        <span
          key={`seg-${seg.index}`}
          {...clickableProps(() => jumpTo(seg.index))}
          onClick={() => jumpTo(seg.index)}
          title={hard ? `Hard to say: ${reasons.join('; ')}` : undefined}
          className={[
            'cursor-pointer rounded transition-colors',
            active ? 'bg-port-accent/30 text-white' : 'hover:bg-port-border/40',
            hard ? 'underline decoration-wavy decoration-port-warning/70 underline-offset-2' : '',
          ].join(' ')}
        >
          {content.slice(seg.start, seg.end)}
        </span>,
      );
      cursor = seg.end;
    });
    if (cursor < content.length) {
      nodes.push(<span key={`gap-${cursor}`}>{content.slice(cursor)}</span>);
    }
    return nodes;
  }, [segments, content, currentIndex, jumpTo]);

  const currentSrc = (currentIndex >= 0 && segments?.[currentIndex])
    ? `/data/audio/${encodeURIComponent(segments[currentIndex].filename)}`
    : undefined;

  const progressPct = totalMs > 0 ? Math.min(100, (elapsedMs / totalMs) * 100) : 0;

  return (
    <Modal open={open} onClose={onClose} size="3xl" backdropClassName="bg-black/70 p-4" panelClassName="bg-port-card border border-port-border rounded-lg">
      <div className="flex flex-col max-h-[85vh]">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-port-border">
          <Volume2 className="w-4 h-4 text-port-accent" />
          <h2 className="text-sm font-semibold text-white">
            Read aloud
            {section ? (
              <span className="text-gray-500 font-normal">
                {' '}— #{section.number} {section.title ? `· ${section.title}` : ''} ({STAGE_LABEL[section.stageId] || section.stageId})
              </span>
            ) : null}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-gray-500 hover:text-white text-sm px-2"
            aria-label="Close read-aloud"
          >
            ✕
          </button>
        </header>

        <div className="px-4 py-3 border-b border-port-border space-y-2.5">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="min-w-[220px]">
              <VoicePicker
                value={voiceId}
                onChange={changeVoice}
                label="Narrator voice"
                placeholder="Default voice"
                previewText="The morning fog burned off slow that day."
                disabled={loading}
              />
            </div>
            <div className="flex items-center gap-2">
              {!segments ? (
                <button
                  type="button"
                  onClick={runNarration}
                  disabled={loading || !content.trim()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
                >
                  {loading ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                  {loading ? 'Synthesizing…' : 'Read aloud'}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={togglePlay}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40"
                  >
                    {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                    {isPlaying ? 'Pause' : 'Play'}
                  </button>
                  <button
                    type="button"
                    onClick={stop}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-sm font-medium border bg-port-bg text-gray-400 border-port-border hover:text-white"
                  >
                    <Square size={13} /> Stop
                  </button>
                </>
              )}
            </div>
          </div>

          {segments ? (
            <div className="space-y-1">
              <div className="h-1.5 w-full rounded bg-port-bg overflow-hidden">
                <div className="h-full bg-port-accent transition-[width] duration-150" style={{ width: `${progressPct}%` }} />
              </div>
              <div className="flex items-center justify-between text-[11px] text-gray-500">
                <span>
                  {segments.length} sentence{segments.length === 1 ? '' : 's'}
                  {currentIndex >= 0 ? ` · ${currentIndex + 1} of ${segments.length}` : ''}
                </span>
                <span>{formatDurationMs(elapsedMs)} / {formatDurationMs(totalMs)}</span>
              </div>
              {hardCount > 0 ? (
                <p className="flex items-center gap-1.5 text-[11px] text-port-warning">
                  <AlertTriangle size={11} />
                  {hardCount} possible trouble spot{hardCount === 1 ? '' : 's'} — underlined below; hover for why.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {segments ? (
            <div className="whitespace-pre-wrap leading-relaxed text-[15px] text-gray-200">
              {renderedProse}
            </div>
          ) : (
            <div className="whitespace-pre-wrap leading-relaxed text-[15px] text-gray-400">
              {content.trim() ? content : <span className="italic text-gray-600">No drafted prose to read aloud yet.</span>}
            </div>
          )}
        </div>
      </div>

      {/* Hidden engine — playback is driven by the controls above. */}
      <audio ref={audioRef} src={currentSrc} onEnded={onEnded} onTimeUpdate={onTimeUpdate} className="hidden">
        <track kind="captions" />
      </audio>
    </Modal>
  );
}
