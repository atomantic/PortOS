import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Music, Pause, Play, SkipBack, SkipForward, Trash2, Upload } from 'lucide-react';
import FilePickerButton from '../ui/FilePickerButton';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import toast from '../ui/Toast';
import { getUploadUrl, uploadFile } from '../../services/api';
import { formatTimecode } from '../../utils/formatters';
import { storyboardTimeline } from '../../../../server/lib/storyboardSongBrief.js';
import SongMarkers from './SongMarkers';
import { aspectClass, MUSICAL_ROLE_LABELS, selectedTake, takeSrc } from './storyboardArt';

const controlButton = 'min-h-[44px] min-w-[44px] inline-flex items-center justify-center gap-1.5 rounded-lg border border-port-border px-2 text-sm text-gray-200 hover:border-port-accent/60 hover:text-white disabled:opacity-40';

// Portrait frames get a narrower stage so the whole frame stays above the fold.
const STAGE_WIDTH = { '9:16': 'max-w-[22rem]', '4:5': 'max-w-md', '1:1': 'max-w-xl' };

/**
 * Play: the animatic. Each panel holds for its estimated seconds (or the
 * default), and a beat pinned to a song marker starts there; the beat and the
 * lyric line (or the panel's line) show in small type. The sound is `song`
 * when given (a music video's own song, `{ src, name, lines }` with its timed
 * lines), else the board's temp track when attached; it is the clock while it
 * sounds. Beats before the song play first, and the sound starts after them.
 */
export default function StoryboardPlayer({ board, sketchNonce, onTempTrack, song = null }) {
  const { panels: timeline, end: panelsEnd, songStartSec } = useMemo(() => storyboardTimeline(board), [board]);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const [audioMissing, setAudioMissing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const audioRef = useRef(null);
  const clockRef = useRef({ base: 0, at: 0 });
  const timeRef = useRef(0);
  const startingRef = useRef(false);
  const track = board.tempTrack;
  const audioSrc = song?.src || (track ? getUploadUrl(track.filename) : null);
  const lines = song ? song.lines || [] : track?.lines || [];
  const audible = !!audioSrc && !audioMissing && audioDuration > 0;
  const soundEnd = audible ? songStartSec + audioDuration : 0;
  const duration = Math.max(panelsEnd, soundEnd);

  useEffect(() => {
    setAudioDuration(0);
    setAudioMissing(false);
  }, [audioSrc]);

  // The sound at board time `t`: playing from the matching song time while
  // the song runs, waiting at its start before it.
  const cueAudio = useCallback((t, start) => {
    const audio = audioRef.current;
    if (!audio || !audible) return;
    if (t >= songStartSec && t < soundEnd) {
      audio.currentTime = t - songStartSec;
      if (start && audio.paused && !startingRef.current) {
        startingRef.current = true;
        audio.play().catch(() => {}).finally(() => { startingRef.current = false; });
      }
    } else {
      audio.pause();
      if (t < songStartSec) audio.currentTime = 0;
    }
  }, [audible, songStartSec, soundEnd]);

  const seek = useCallback((t) => {
    const next = Math.max(0, Math.min(t, duration));
    timeRef.current = next;
    clockRef.current = { base: next, at: performance.now() };
    setTime(next);
    cueAudio(next, playing);
  }, [duration, cueAudio, playing]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame = 0;
    const tick = (now) => {
      const audio = audioRef.current;
      let t;
      // While the sound plays it is the clock; before it starts, past its
      // end (or with none) the panels keep time on their own.
      if (audio && !audio.paused && !audio.ended) {
        t = songStartSec + audio.currentTime;
        clockRef.current = { base: t, at: now };
      } else {
        t = clockRef.current.base + (now - clockRef.current.at) / 1000;
        // The prelude has run out: the song starts here.
        if (audio && audible && audio.paused && !startingRef.current && t >= songStartSec && t < soundEnd && audio.currentTime === 0) cueAudio(t, true);
      }
      if (t >= duration) {
        timeRef.current = duration;
        setTime(duration);
        setPlaying(false);
        return;
      }
      timeRef.current = t;
      setTime(t);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, songStartSec, soundEnd, audible, cueAudio]);

  const play = () => {
    const from = timeRef.current >= duration ? 0 : timeRef.current;
    timeRef.current = from;
    clockRef.current = { base: from, at: performance.now() };
    setTime(from);
    const audio = audioRef.current;
    if (audio && audible && from < songStartSec) {
      // Phones only let sound start from a tap: unlock it now, silently, for when the song comes in.
      audio.muted = true;
      audio.play().then(() => { audio.pause(); audio.currentTime = 0; }).catch(() => {}).finally(() => { audio.muted = false; });
    } else cueAudio(from, true);
    setPlaying(true);
  };

  const pause = () => {
    audioRef.current?.pause();
    setPlaying(false);
  };

  const index = timeline.findIndex((entry) => time < entry.end);
  const current = index >= 0 ? timeline[index] : null;
  const next = index >= 0 ? timeline[index + 1] : null;
  const jump = (step) => {
    const entry = timeline[(index < 0 ? timeline.length : index) + step];
    if (entry) seek(entry.start);
  };

  const attach = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    const saved = await uploadFile(file, file.name, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not upload the temp track');
      return null;
    });
    // A new mix of the same song keeps its section and lyric marks.
    if (saved?.filename) await onTempTrack({ ...track, filename: saved.filename, name: file.name });
    setUploading(false);
  };

  const marks = (track?.sections?.length || 0) + (track?.lines?.length || 0);
  const remove = () => {
    pause();
    onTempTrack(null);
  };

  const take = selectedTake(current?.panel);
  const src = takeSrc(take, sketchNonce?.(take?.sketchKey));
  const nextTake = selectedTake(next?.panel);
  const nextSrc = takeSrc(nextTake, sketchNonce?.(nextTake?.sketchKey));
  const role = current?.beat.musicalRole ? MUSICAL_ROLE_LABELS[current.beat.musicalRole] : null;
  // The stamped lyric line sounding now, else the panel's own line.
  const stamped = lines.filter((line) => line.at !== null);
  const songTime = time - songStartSec;
  const lyric = stamped.length
    ? (songTime >= 0 && stamped.reduce((found, line) => (line.at <= songTime && (!found || line.at >= found.at) ? line : found), null)?.text) || ''
    : current?.panel.dialogue || '';

  return (
    <div className="mx-auto w-full max-w-3xl space-y-2">
      {audioSrc && (
        <audio ref={audioRef} src={audioSrc} preload="auto"
          onLoadedMetadata={(e) => setAudioDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0)}
          onError={() => setAudioMissing(true)} />
      )}
      <div className={`mx-auto w-full ${STAGE_WIDTH[board.aspectRatio] || ''}`}>
        <div className={`${aspectClass(board.aspectRatio)} relative w-full overflow-hidden rounded-lg bg-black`}>
          {!timeline.length ? (
            <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-gray-400">Add panels to play the animatic.</p>
          ) : !current ? (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">End</p>
          ) : src ? (
            <img src={src} alt={current.panel.action || `Panel ${current.number}`} className="h-full w-full object-cover" />
          ) : (
            <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-gray-300">{current.panel.action || `Panel ${current.number}`}</p>
          )}
          {current && (
            <>
              <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px] tabular-nums">
                {current.number}{role ? ` · ${role}` : ''}
              </span>
              <div className="absolute inset-x-0 bottom-0 space-y-0.5 p-2 text-center">
                <p className="port-media-overlay-strong mx-auto w-fit max-w-full truncate rounded px-1 text-[10px]">{current.beat.title || `Beat ${current.beatIndex + 1}`}</p>
                {lyric && <p className="port-media-overlay-strong mx-auto w-fit max-w-full rounded px-1 text-[11px] line-clamp-2">{lyric}</p>}
              </div>
            </>
          )}
        </div>
        {/* Warms the next frame so the cut lands without a blank. */}
        {nextSrc && nextSrc !== src && <img src={nextSrc} alt="" aria-hidden="true" className="hidden" />}
      </div>

      <div className="flex items-center gap-1.5">
        <button type="button" onClick={() => jump(-1)} disabled={!timeline.length} aria-label="Previous panel" className={controlButton}><SkipBack size={16} aria-hidden="true" /></button>
        <button type="button" onClick={playing ? pause : play} disabled={!duration} aria-label={playing ? 'Pause' : 'Play'} className={`pointer-coarse:min-h-11 pointer-coarse:min-w-11 ${controlButton} bg-port-accent/20 border-port-accent/50`}>
          {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
        <button type="button" onClick={() => jump(1)} disabled={!timeline.length} aria-label="Next panel" className={controlButton}><SkipForward size={16} aria-hidden="true" /></button>
        <label htmlFor="storyboard-play-scrub" className="sr-only">Playhead</label>
        <input id="storyboard-play-scrub" type="range" min={0} max={duration || 0} step={0.01} value={Math.min(time, duration)}
          onChange={(e) => seek(Number(e.target.value))} disabled={!duration} className="min-w-0 flex-1 accent-port-accent" />
        <span className="shrink-0 text-xs text-gray-400 tabular-nums">{formatTimecode(time)} / {formatTimecode(duration)}</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        {song ? (
          <>
            <Music size={16} className="shrink-0 text-gray-400" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-gray-300" title={song.name}>{song.name}</span>
            {songStartSec > 0 && <span className="shrink-0 text-xs text-gray-400 tabular-nums">starts at {formatTimecode(songStartSec)}</span>}
          </>
        ) : track ? (
          <>
            <Music size={16} className="shrink-0 text-gray-400" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-gray-300" title={track.name}>{track.name}</span>
            <FilePickerButton id="storyboard-temp-track" accept="audio/*" onChange={attach} disabled={uploading} className={controlButton}
              ariaLabel={uploading ? undefined : 'Replace temp track'}>
              <Upload size={16} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Replace'}
            </FilePickerButton>
            <button type="button" onClick={() => (marks ? setConfirmRemove(true) : remove())} aria-label="Remove temp track" className={controlButton}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </>
        ) : (
          <FilePickerButton id="storyboard-temp-track" accept="audio/*" onChange={attach} disabled={uploading} className={controlButton}>
            <Music size={16} aria-hidden="true" /> {uploading ? 'Uploading…' : 'Add temp track'}
          </FilePickerButton>
        )}
        {audioMissing && <p role="alert" className="basis-full text-xs text-port-warning">{song ? "The song can't be played on this machine." : "The temp track can't be played on this machine. Replace it to hear it here."}</p>}
        {confirmRemove && (
          <InlineConfirmRow autoFocus aria-label="Remove temp track" className="basis-full" confirmText="Remove"
            question={`Remove the temp track? Its ${marks} section and lyric mark${marks === 1 ? '' : 's'} go with it, and beats pinned to them are unpinned.`}
            onConfirm={() => { setConfirmRemove(false); remove(); }} onCancel={() => setConfirmRemove(false)} />
        )}
      </div>
      {track && !song && <SongMarkers track={track} time={Math.max(0, songTime)} onSeek={(at) => seek(songStartSec + at)} onChange={onTempTrack} />}
    </div>
  );
}
