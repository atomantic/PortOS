import { useId, useRef, useState } from 'react';
import { publishCropRect } from '../../../../server/lib/musicVideo/musicVideoPublishCrop.js';

// Scrub in 50 ms steps within the half-open hook window.
const STEPS_PER_SECOND = 20;
const percent = (fraction) => `${fraction * 100}%`;

export default function PublishCropPreview({ preview, position, onPosition, onMediaState }) {
  const { filename, width, height, startSec, endSec } = preview;
  const id = useId();
  const video = useRef(null);
  const frame = useRef(null);
  const drag = useRef(null);
  const [scrub, setScrub] = useState(0);
  const [ready, setReady] = useState(false);
  const rect = publishCropRect(width, height, position);
  const maxX = publishCropRect(width, height, 1).x;
  const lastStep = Math.max(0, Math.ceil((endSec - startSec) * STEPS_PER_SECOND) - 1);
  const matchesMaster = (media) => media.videoWidth === width && media.videoHeight === height && media.duration > startSec;
  const readFrame = (event) => {
    const media = event.currentTarget;
    if (!ready && matchesMaster(media) && !media.seeking && media.currentTime >= startSec - 0.001) {
      setReady(true);
      onMediaState(preview);
    }
  };
  return (
    <div className="max-w-xl space-y-2 text-xs">
      <div ref={frame} className="relative overflow-hidden rounded bg-black" style={{ aspectRatio: `${width} / ${height}` }}>
        <video ref={video} playsInline preload="auto" aria-label="Final master crop preview"
          className={`block size-full ${ready ? '' : 'invisible'}`} src={`/data/videos/${encodeURIComponent(filename)}`}
          onLoadedMetadata={event => {
            const media = event.currentTarget;
            if (!matchesMaster(media)) {
              onMediaState(preview, 'The master does not match the crop preview. Refresh the preview.');
              return;
            }
            if (startSec) media.currentTime = startSec;
          }}
          onLoadedData={readFrame} onSeeked={readFrame}
          onError={() => onMediaState(preview, 'The master video could not be loaded. Refresh the preview.')} />
        {ready && <div aria-hidden="true" className="absolute touch-none cursor-ew-resize border-2 border-white shadow-[0_0_0_100vmax_rgba(0,0,0,0.60)]"
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
          onLostPointerCapture={() => { drag.current = null; }} />}
      </div>
      <div>
        <label htmlFor={`${id}-time`}>Scrub hook window ({startSec}–{endSec} s)</label>
        <input id={`${id}-time`} type="range" min="0" max={lastStep} value={scrub}
          aria-valuetext={`${(scrub / STEPS_PER_SECOND).toFixed(2)} seconds into the hook`}
          disabled={!ready || !lastStep} className="block w-full min-h-8 pointer-coarse:min-h-11"
          onChange={event => {
            const step = Number(event.target.value);
            video.current.currentTime = startSec + step / STEPS_PER_SECOND;
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
      <p className="text-port-text-muted">Drag the guide or use the position slider. The crop stays fixed throughout the hook.</p>
    </div>
  );
}
