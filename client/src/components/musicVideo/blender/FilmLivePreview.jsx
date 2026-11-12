import { useEffect, useRef, useState } from 'react';
import { blenderShotClip } from '../../../lib/musicVideoBlender.js';
import { formatTimecode } from '../../../utils/formatters.js';
import { buttonCls } from './blenderStyles.js';

/** A timeline clock also works for silent films; missing shots deliberately show black. */
export default function FilmLivePreview({ state, durationSec, audioUrl, mediaUrl }) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const video = useRef(null);
  const audio = useRef(null);
  const clock = useRef(0);
  const shot = state?.manifest?.shots?.find(item => time >= item.start && time < item.end);
  const clip = shot && blenderShotClip(state.renders?.[shot.id]);
  const source = clip ? `${mediaUrl(clip.render.file)}&v=${encodeURIComponent(clip.render.finishedAt || '')}` : null;

  useEffect(() => {
    if (!playing) return undefined;
    let frame;
    let previous = performance.now();
    const tick = now => {
      clock.current = audioUrl && audio.current && !audio.current.paused
        ? audio.current.currentTime : clock.current + (now - previous) / 1000;
      previous = now;
      if (clock.current >= durationSec) { clock.current = durationSec; setPlaying(false); }
      else frame = requestAnimationFrame(tick);
      setTime(clock.current);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, audioUrl, durationSec]);

  useEffect(() => {
    const element = audio.current;
    if (!element) return;
    if (playing) { element.currentTime = clock.current; element.play().catch(() => setPlaying(false)); }
    else element.pause();
  }, [playing, audioUrl]);

  useEffect(() => {
    const element = video.current;
    if (!element || !shot) return;
    const target = Math.max(0, time - shot.start);
    if (Math.abs(element.currentTime - target) > (playing ? 0.15 : 0.01)) element.currentTime = target;
    if (playing && element.paused) element.play().catch(() => setPlaying(false));
    if (!playing) element.pause();
  }, [time, playing, shot, source]);

  const seek = value => {
    clock.current = value;
    setTime(value);
    if (audio.current) audio.current.currentTime = value;
  };
  return <section aria-label="Film live preview" className="space-y-2 rounded-lg border border-port-border p-3">
    <h3 className="text-sm font-medium">Film (live)</h3>
    <div className="flex max-h-[45dvh] w-full items-center justify-center rounded bg-black" style={{ aspectRatio: `${state?.settings?.width || 16} / ${state?.settings?.height || 9}` }}>
      {source ? <video ref={video} key={source} src={source} muted playsInline preload="auto" className="h-full max-h-[45dvh] w-full object-contain"
        onLoadedMetadata={() => { if (video.current) video.current.currentTime = Math.max(0, clock.current - shot.start); }} />
        : <span className="text-xs text-gray-400">{shot ? 'Shot has no render yet' : 'No shot at this time'}</span>}
    </div>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={buttonCls} onClick={() => { if (time >= durationSec) seek(0); setPlaying(value => !value); }}>{playing ? 'Pause film' : 'Play film'}</button>
      <label htmlFor="film-live-time" className="text-xs">{formatTimecode(time)} / {formatTimecode(durationSec)}</label>
      <input id="film-live-time" aria-label="Film time" type="range" min="0" max={durationSec} step={1 / (state?.settings?.fps || 24)} value={time}
        className="min-w-0 flex-1" onChange={event => seek(Number(event.target.value))} />
    </div>
    {audioUrl && <audio ref={audio} src={audioUrl} preload="metadata" onError={() => setPlaying(false)} />}
  </section>;
}
