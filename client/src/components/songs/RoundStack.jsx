/**
 * RoundStack — render several songs as simultaneous parts (a quodlibet / round
 * stack). Rounds like "Hey Ho Nobody Home", "Ah Poor Bird" and "Rose Rose Rose
 * Red" share one chord cycle and are sung at the same time; this view stacks
 * each partner song's melody (ScoreSheet) and lyrics in one column so a singer
 * can see every part at once, and plays the recorded takes from ALL of them
 * together on a single AudioContext.
 *
 * Read-only. It reuses ScoreSheet (the same SVG staff the editor renders) and
 * createLayeredPlayer (the within-song mixer) widened across songs — no new
 * rendering or audio machinery. `songs` is the primary song followed by its
 * resolved partners; the caller fetches the partner records.
 */

import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Play, Square, Music, Layers } from 'lucide-react';
import toast from '../ui/Toast';
import ScoreSheet from './ScoreSheet';
import { scoreHasMusic } from '../../lib/scoreNotation';
import { createLayeredPlayer } from '../../lib/songPlayback';
import { getUploadUrl } from '../../services/api';
import { rhythmShapeLabel } from '../../lib/songCraft';

const hasText = (v) => typeof v === 'string' && v.trim().length > 0;

export default function RoundStack({ songs = [] }) {
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef(null);
  // Bumped on every stop / takes-change / unmount. createLayeredPlayer only
  // marks itself "playing" AFTER decoding, so a stop() issued mid-decode no-ops
  // and the awaited play() would start the mix anyway. We capture this token
  // before awaiting and silence the player if it advanced while we were decoding.
  const playGenRef = useRef(0);

  // Value-stable content signature of every take across the stacked songs.
  // ReadView hands us a fresh `[song, ...partners]` array on each render, so
  // keying `takes` off array identity (`[songs]`) would rebuild it — and trip the
  // takes-changed cleanup that stops playback — on EVERY unrelated parent render
  // (Save, recording-state updates). This string changes only when the takes
  // themselves do, keeping `takes` (and the running mix) steady otherwise.
  const takesKey = songs
    .flatMap((s) => (s.recordings || []).map((r) => `${s.id}:${r.id}:${r.filename}:${r.muted ? 1 : 0}`))
    .join('|');
  // Every saved take across all stacked songs, keyed by a song-namespaced id so
  // two songs' recordings can't collide in the mixer's id map.
  const takes = useMemo(
    () => songs.flatMap((s) => (s.recordings || []).map((r) => ({
      id: `${s.id}:${r.id}`,
      url: getUploadUrl(r.filename),
      muted: r.muted,
    }))),
    // `songs` intentionally excluded — takesKey is its content signature, so an
    // equivalent-but-new songs array doesn't churn `takes`.
    [takesKey],
  );
  const audibleCount = useMemo(() => takes.filter((t) => !t.muted).length, [takes]);

  // Stop and release the mixer on unmount AND whenever the stacked takes change
  // — otherwise navigating to another partner (or any songs-prop change) while
  // ?stack=1 is open would leave the previous mix audibly playing under the new
  // stack. Resetting `playing` keeps the button in sync with the silenced mix.
  useEffect(() => () => { playGenRef.current += 1; playerRef.current?.stop(); setPlaying(false); }, [takes]);

  const stop = useCallback(() => {
    playGenRef.current += 1; // invalidate any in-flight (still-decoding) play
    playerRef.current?.stop();
    setPlaying(false);
  }, []);

  const playAll = useCallback(async () => {
    playerRef.current?.stop();
    const gen = (playGenRef.current += 1);
    const player = createLayeredPlayer(takes);
    player.onEnded(() => setPlaying(false));
    playerRef.current = player;
    setPlaying(true);
    try {
      await player.play();
      // Stopped or navigated away while decoding? The player only just marked
      // itself playable, so stop it now before the scheduled sources sound.
      if (playGenRef.current !== gen) player.stop();
    } catch (err) {
      // A take URL that 404s or fails to decode rejects play() — reset the button
      // (mirrors SongRecordings) unless a newer action already superseded us.
      if (playGenRef.current === gen) {
        toast.error(err?.message || 'Playback failed');
        setPlaying(false);
      }
    }
  }, [takes]);

  if (songs.length === 0) return null;

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
          <Layers size={15} className="text-port-accent" /> Round stack — {songs.length} parts together
        </h2>
        {audibleCount > 0 && (
          <button
            type="button"
            onClick={playing ? stop : playAll}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-port-accent text-white hover:bg-port-accent/90"
          >
            {playing ? <Square size={14} /> : <Play size={14} />}
            {playing ? 'Stop' : `Play all parts (${audibleCount})`}
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500">
        These rounds share a chord cycle — each line is a different melody sung at the same time. Record a take on each
        song, then play them stacked.
      </p>

      <div className="space-y-4">
        {songs.map((s, i) => {
          const feel = s.rhythmShapeId ? rhythmShapeLabel(s.rhythmShapeId) : '';
          const sections = s.sections || [];
          return (
            <div key={s.id} className="bg-port-card border border-port-border rounded-lg p-4 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Music size={14} className="text-port-accent shrink-0" />
                  {/* The primary song is the one being viewed; partners link out. */}
                  {i === 0 ? (
                    <span>{s.title || 'Untitled song'}</span>
                  ) : (
                    <Link to={`/rounds/${s.id}`} className="hover:text-port-accent transition-colors">
                      {s.title || 'Untitled song'}
                    </Link>
                  )}
                </h3>
                <span className="text-xs text-gray-500">
                  {[hasText(s.key) && s.key, feel].filter(Boolean).join(' · ')}
                </span>
              </div>

              {scoreHasMusic(s.score) && (
                <div className="overflow-x-auto">
                  <ScoreSheet text={s.score} />
                </div>
              )}

              {sections.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {sections.map((sec) => (
                    <div key={sec.id}>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-port-accent mb-1">{sec.label || 'Section'}</h4>
                      {hasText(sec.lyrics)
                        ? <p className="text-sm text-gray-100 whitespace-pre-wrap leading-relaxed">{sec.lyrics}</p>
                        : <p className="text-xs text-gray-600 italic">No lyrics</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
