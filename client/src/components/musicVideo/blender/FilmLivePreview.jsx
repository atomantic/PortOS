import { useEffect, useRef, useState } from 'react';
import { blenderShotClip } from '../../../lib/musicVideoBlender.js';
import { formatTimecode } from '../../../utils/formatters.js';
import { buttonCls } from './blenderStyles.js';

/** A timeline clock also works for silent films; missing shots deliberately show black.
 * `durationSec` is the song. A lead-in shot starts below 0 and plays first, in silence, then the song. */
export default function FilmLivePreview({ state, durationSec, audioUrl, mediaUrl }) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const video = useRef(null);
  const audio = useRef(null);
  const clock = useRef(0);
  const playRequest = useRef(0);
  const starts = (state?.manifest?.shots || []).map(item => item.start).filter(value => Number.isFinite(value));
  const leadSec = starts.length ? Math.max(0, -Math.min(0, Math.min(...starts))) : 0;
  const totalSec = leadSec + (Number(durationSec) || 0);
  const songTime = time - leadSec;
  const shot = state?.manifest?.shots?.find(item => songTime >= item.start && songTime < item.end);
  const clip = shot && blenderShotClip(state.renders?.[shot.id]);
  const source = clip ? `${mediaUrl(clip.render.file)}&v=${encodeURIComponent(clip.render.finishedAt || '')}` : null;

  useEffect(() => {
    setStarting(false);
    return () => { playRequest.current += 1; };
  }, [audioUrl]);

  useEffect(() => {
    if (!playing) return undefined;
    let frame;
    let previous = performance.now();
    const tick = now => {
      const dt = (now - previous) / 1000;
      previous = now;
      if (leadSec === 0 && audioUrl && audio.current && !audio.current.paused) {
        clock.current = audio.current.currentTime;
      } else if (leadSec > 0 && audioUrl && audio.current && !audio.current.paused && clock.current >= leadSec) {
        clock.current = audio.current.currentTime + leadSec;
      } else {
        clock.current += dt;
        if (leadSec > 0 && audioUrl && audio.current && clock.current >= leadSec && audio.current.paused) {
          audio.current.currentTime = clock.current - leadSec;
          audio.current.play().catch(() => setPlaying(false));
        }
      }
      if (clock.current >= totalSec) { clock.current = totalSec; setPlaying(false); }
      else frame = requestAnimationFrame(tick);
      setTime(clock.current);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, audioUrl, leadSec, totalSec]);

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    if (playing && clock.current - leadSec >= 0) {
      element.currentTime = clock.current - leadSec;
      if (element.paused) element.play().catch(() => setPlaying(false));
    } else element.pause();
  }, [playing, audioUrl, leadSec]);

  useEffect(() => {
    const element = video.current;
    if (!element || !shot) return;
    const target = Math.max(0, songTime - shot.start);
    if (Math.abs(element.currentTime - target) > (playing ? 0.15 : 0.01)) element.currentTime = target;
    if (playing && element.paused) element.play().catch(() => setPlaying(false));
    if (!playing) element.pause();
  }, [time, playing, shot, source, songTime]);

  const seek = value => {
    clock.current = value;
    setTime(value);
    if (!audio.current) return;
    if (leadSec === 0) { audio.current.currentTime = value; return; }
    if (value < leadSec) audio.current.pause();
    else {
      audio.current.currentTime = value - leadSec;
      if (playing && audio.current.paused) audio.current.play().catch(() => setPlaying(false));
    }
  };
  const togglePlayback = () => {
    if (playing) { setPlaying(false); return; }
    if (starting) return;
    if (time >= totalSec) seek(0);
    const element = audio.current;
    if (!element) { setPlaying(true); return; }
    const request = ++playRequest.current;
    const beforeSong = clock.current < leadSec;
    const volume = element.volume;
    element.currentTime = Math.max(0, clock.current - leadSec);
    // Start this media element during the click so browsers grant it playback.
    // The silent start is paused only once play resolves; the song remains at 0
    // until the timeline reaches it, without depending on a later user gesture.
    if (beforeSong) element.volume = 0;
    setStarting(true);
    element.play().then(() => {
      if (beforeSong) { element.pause(); element.currentTime = 0; element.volume = volume; }
      if (playRequest.current === request && audio.current === element) setPlaying(true);
    }).catch(() => {
      if (beforeSong) element.volume = volume;
      if (playRequest.current === request) setPlaying(false);
    }).finally(() => { if (playRequest.current === request) setStarting(false); });
  };
  return <section aria-label="Film live preview" className="space-y-2 rounded-lg border border-port-border p-3">
    <h3 className="text-sm font-medium">Film (live)</h3>
    <div className="flex max-h-[45dvh] w-full items-center justify-center rounded bg-black" style={{ aspectRatio: `${state?.settings?.width || 16} / ${state?.settings?.height || 9}` }}>
      {source ? <video ref={video} key={source} src={source} muted playsInline preload="auto" className="h-full max-h-[45dvh] w-full object-contain"
        onLoadedMetadata={() => { if (video.current && shot) video.current.currentTime = Math.max(0, clock.current - leadSec - shot.start); }} />
        : <span className="text-xs text-gray-400">{shot ? 'Shot has no render yet' : 'No shot at this time'}</span>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={buttonCls} onClick={togglePlayback} disabled={starting}>{starting ? 'Starting film…' : playing ? 'Pause film' : 'Play film'}</button>
      <label htmlFor="film-live-time" className="text-xs">{formatTimecode(time)} / {formatTimecode(totalSec)}</label>
      <input id="film-live-time" aria-label="Film time" type="range" min="0" max={totalSec} step={1 / (state?.settings?.fps || 24)} value={time}
        className="min-w-0 flex-1" onChange={event => seek(Number(event.target.value))} />
    </div>
    {audioUrl && <audio ref={audio} src={audioUrl} preload="metadata" onError={() => setPlaying(false)} />}
  </section>;
}
