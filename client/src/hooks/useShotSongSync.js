import { useEffect, useRef } from 'react';

// Past this gap between where the song is and where the picture says it should be, the song is re-seeked.
const DRIFT_SEC = 0.08;

/**
 * Plays the master song under a silent, looping shot video. The video is the
 * clock: the audio sits at `startSec + video.currentTime`, is re-seeked when
 * the video seeks, loops or drifts past 80 ms, and pauses whenever the video
 * does, at the video's playback rate. With `enabled` false the audio stays paused. `sourceKey` names the
 * video file, so a new shot re-attaches. `onTime(songSec)` reports the song
 * position as the video plays (for a timeline playhead).
 *
 * Returns `{ videoRef, audioRef }` for the two media elements. Binds no keys.
 */
export default function useShotSongSync({ startSec = 0, enabled = true, sourceKey = null, onTime = null }) {
  const videoRef = useRef(null);
  const audioRef = useRef(null);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;

  useEffect(() => {
    const video = videoRef.current;
    const audio = audioRef.current;
    if (!video) return undefined;
    const songTime = () => startSec + (video.currentTime || 0);
    const alignRate = () => { if (audio) audio.playbackRate = video.playbackRate; };
    const align = () => {
      if (!audio || !enabled) return;
      alignRate();
      const target = songTime();
      if (Math.abs((audio.currentTime || 0) - target) > DRIFT_SEC) audio.currentTime = target;
    };
    const playSong = () => {
      if (!audio || !enabled || video.paused) return;
      align();
      // A browser may refuse sound before the first tap; the picture still plays.
      if (audio.paused) Promise.resolve(audio.play?.()).catch(() => {});
    };
    const pauseSong = () => { if (audio && !audio.paused) audio.pause(); };
    const onTick = () => {
      onTimeRef.current?.(songTime());
      playSong();
    };
    const onSeek = () => {
      onTimeRef.current?.(songTime());
      align();
    };
    video.addEventListener('play', playSong);
    video.addEventListener('ratechange', alignRate);
    video.addEventListener('playing', playSong);
    video.addEventListener('timeupdate', onTick);
    video.addEventListener('seeking', onSeek);
    video.addEventListener('seeked', onSeek);
    video.addEventListener('pause', pauseSong);
    video.addEventListener('waiting', pauseSong);
    video.addEventListener('ended', pauseSong);
    alignRate();
    if (enabled) playSong(); else pauseSong();
    return () => {
      video.removeEventListener('play', playSong);
      video.removeEventListener('ratechange', alignRate);
      video.removeEventListener('playing', playSong);
      video.removeEventListener('timeupdate', onTick);
      video.removeEventListener('seeking', onSeek);
      video.removeEventListener('seeked', onSeek);
      video.removeEventListener('pause', pauseSong);
      video.removeEventListener('waiting', pauseSong);
      video.removeEventListener('ended', pauseSong);
      pauseSong();
    };
  }, [startSec, enabled, sourceKey]);

  return { videoRef, audioRef };
}
