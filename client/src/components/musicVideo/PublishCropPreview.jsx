import { useId, useMemo, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { publishCropRect } from '../../../../server/lib/musicVideo/musicVideoPublishCrop.js';
import { verticalSafeZonesSvg } from '../../../../server/lib/musicVideo/musicVideoVerticalFrame.js';

// Scrub in 50 ms steps within the selected window.
const STEPS_PER_SECOND = 20;
const percent = (fraction) => `${fraction * 100}%`;
const toSvgDataUri = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

export default function PublishCropPreview({ preview, position, onPosition, onMediaState, span = 'hook', onSpanChange = null }) {
  const { filename, width, height, startSec, endSec } = preview;
  const id = useId();
  const video = useRef(null);
  const frame = useRef(null);
  const drag = useRef(null);
  const [scrub, setScrub] = useState(0);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [fullDurationSec, setFullDurationSec] = useState(endSec);
  const [showSafeZones, setShowSafeZones] = useState(true);
  const safeZonesUri = useMemo(() => toSvgDataUri(verticalSafeZonesSvg()), []);
  const windowStart = span === 'full' ? 0 : startSec;
  const windowEnd = span === 'full' ? Math.max(endSec, fullDurationSec) : endSec;
  const rect = publishCropRect(width, height, position);
  const maxX = publishCropRect(width, height, 1).x;
  const lastStep = Math.max(0, Math.ceil((windowEnd - windowStart) * STEPS_PER_SECOND) - 1);
  const matchesMaster = (media) => media.videoWidth === width && media.videoHeight === height && media.duration > startSec;
  const readFrame = (event) => {
    const media = event.currentTarget;
    if (!ready && matchesMaster(media) && !media.seeking && media.currentTime >= windowStart - 0.001) {
      setReady(true);
      onMediaState(preview);
    }
  };
  const togglePlay = () => {
    const media = video.current;
    if (!media) return;
    if (media.paused) {
      if (media.currentTime < windowStart || media.currentTime >= windowEnd) media.currentTime = windowStart;
      media.play().then(() => setPlaying(true)).catch(() => {});
    } else {
      media.pause();
      setPlaying(false);
    }
  };
  return (
    <div className="max-w-xl space-y-2 text-xs">
      <div ref={frame} className="relative overflow-hidden rounded bg-black" style={{ aspectRatio: `${width} / ${height}` }}>
        <video ref={video} muted playsInline preload="auto" aria-label="Final master crop preview"
          className={`block size-full ${ready ? '' : 'invisible'}`} src={`/data/videos/${encodeURIComponent(filename)}`}
          onLoadedMetadata={event => {
            const media = event.currentTarget;
            if (!matchesMaster(media)) {
              onMediaState(preview, 'The master does not match the crop preview. Refresh the preview.');
              return;
            }
            if (Number.isFinite(media.duration) && media.duration > 0) setFullDurationSec(media.duration);
            if (windowStart) media.currentTime = windowStart;
          }}
          onLoadedData={readFrame} onSeeked={readFrame}
          onTimeUpdate={event => {
            const media = event.currentTarget;
            if (playing && media.currentTime >= windowEnd) {
              media.pause();
              setPlaying(false);
            }
            setScrub(Math.max(0, Math.min(lastStep, Math.round((media.currentTime - windowStart) * STEPS_PER_SECOND))));
          }}
          onEnded={() => setPlaying(false)}
          onError={() => onMediaState(preview, 'The master video could not be loaded. Refresh the preview.')} />
        {ready && <div aria-hidden="true" className="absolute touch-none cursor-ew-resize overflow-hidden border-2 border-white shadow-[0_0_0_100vmax_rgba(0,0,0,0.60)]"
          style={{ left: percent(rect.x / width), top: percent(rect.y / height), width: percent(rect.width / width), height: percent(rect.height / height) }}
          onPointerDown={event => {
            if (!event.isPrimary || event.button !== 0) return;
            drag.current = { x: event.clientX, position };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={event => {
            if (!drag.current || !event.isPrimary) return;
            const travel = frame.current.getBoundingClientRect().width * maxX / width;
            const next = drag.current.position + (event.clientX - drag.current.x) / travel;
            onPosition(Math.round(Math.max(0, Math.min(1, next)) * 100) / 100);
          }}
          onLostPointerCapture={() => { drag.current = null; }}>
          {showSafeZones && <img src={safeZonesUri} alt="" className="pointer-events-none h-full w-full" />}
        </div>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={togglePlay} disabled={!ready} aria-label={playing ? 'Pause crop preview' : 'Play crop preview'}
          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center gap-1 rounded border border-port-border bg-port-bg px-2 text-port-text hover:border-port-accent disabled:opacity-50 pointer-fine:sm:min-h-[28px] pointer-fine:sm:min-w-0">
          {playing ? <Pause size={12} /> : <Play size={12} />} {playing ? 'Pause' : 'Play'}
        </button>
        {onSpanChange && (
          <div className="flex items-center gap-1.5">
            <label htmlFor={`${id}-span`} className="text-port-text-muted">Vertical length</label>
            <select id={`${id}-span`} value={span} onChange={(e) => {
              const nextSpan = e.target.value;
              onSpanChange(nextSpan);
              setScrub(0);
              if (video.current) { video.current.pause(); setPlaying(false); video.current.currentTime = nextSpan === 'full' ? 0 : startSec; }
            }} className="rounded border border-port-border bg-port-bg px-2 py-1 min-h-11 pointer-fine:sm:min-h-0">
              <option value="hook">Hook slice</option>
              <option value="full">Full video (TikTok)</option>
            </select>
          </div>
        )}
        <label htmlFor={`${id}-safe`} className="inline-flex items-center gap-1.5 min-h-11 pointer-fine:sm:min-h-0">
          <input id={`${id}-safe`} type="checkbox" checked={showSafeZones} onChange={(e) => setShowSafeZones(e.target.checked)} />
          Show TikTok safe zones
        </label>
      </div>
      <div>
        <label htmlFor={`${id}-time`}>Scrub {span === 'full' ? 'full video' : 'hook window'} ({Math.round(windowStart)}–{Math.round(windowEnd)} s)</label>
        <input id={`${id}-time`} type="range" min="0" max={lastStep} value={scrub}
          aria-valuetext={`${(scrub / STEPS_PER_SECOND).toFixed(2)} seconds into the ${span === 'full' ? 'video' : 'hook'}`}
          disabled={!ready || !lastStep} className="block w-full min-h-8 pointer-coarse:min-h-11"
          onChange={event => {
            const step = Number(event.target.value);
            video.current.currentTime = windowStart + step / STEPS_PER_SECOND;
            setScrub(step);
          }} />
      </div>
      <div>
        <label htmlFor={`${id}-position`}>Horizontal crop position</label>
        <input id={`${id}-position`} type="range" min="0" max="100" value={Math.round(position * 100)}
          aria-valuetext={`${Math.round(position * 100)}% from left`}
          disabled={!ready} className="block w-full min-h-8 pointer-coarse:min-h-11"
          onChange={event => onPosition(Number(event.target.value) / 100)} />
      </div>
      <p className="text-port-text-muted">Drag the guide or use the position slider. The crop stays fixed throughout the {span === 'full' ? 'video' : 'hook'}.</p>
    </div>
  );
}
