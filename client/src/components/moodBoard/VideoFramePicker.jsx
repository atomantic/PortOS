/**
 * Visual frame picker for a mood board video pin.
 *
 * A large preview with a zoomable filmstrip under it: drag across the strip to
 * scrub, zoom in to spread the frames out, step one frame at a time, then tap
 * "Pick" to keep the moment on screen. "Add" sends the picked times to the
 * server, which extracts each one at source resolution.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play, Plus, X, ZoomIn, ZoomOut } from 'lucide-react';
import Modal from '../ui/Modal';

const MAX_PICKS = 24;
const FRAME_SEC = 1 / 30;
const ZOOMS = [1, 2, 4, 8];
const THUMB_HEIGHT = 56;

// Rounded to centiseconds before splitting, so 59.996 s reads 1:00.00, not 0:60.00.
const formatFrameTime = (sec) => {
  const cs = Math.round(sec * 100);
  return `${Math.floor(cs / 6000)}:${((cs % 6000) / 100).toFixed(2).padStart(5, '0')}`;
};

// Draw evenly spaced thumbnails from a second, hidden video so the preview
// never jumps while the strip fills in. `isCurrent` drops a superseded run.
async function drawThumbnails(src, duration, count, isCurrent, onThumb) {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = src;
  const canvas = document.createElement('canvas');
  for (let i = 0; i < count && isCurrent(); i++) {
    const time = ((i + 0.5) / count) * duration;
    const seeked = new Promise((resolve) => { video.onseeked = resolve; video.onerror = resolve; });
    video.currentTime = time;
    await seeked;
    if (!isCurrent() || !video.videoWidth) break;
    canvas.height = THUMB_HEIGHT * 2;
    canvas.width = Math.round((video.videoWidth / video.videoHeight) * canvas.height);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    onThumb(i, canvas.toDataURL('image/jpeg', 0.7));
  }
  video.removeAttribute('src');
  video.load();
}

export default function VideoFramePicker({ src, poster, busy = false, onAdd, onClose }) {
  const videoRef = useRef(null);
  const stripRef = useRef(null);
  const scrubbingRef = useRef(false);
  const [duration, setDuration] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [thumbs, setThumbs] = useState([]);
  const [picked, setPicked] = useState([]);

  const thumbCount = Math.min(64, 8 * zoom);
  useEffect(() => {
    if (!duration) return undefined;
    let active = true;
    setThumbs(Array(thumbCount).fill(null));
    drawThumbnails(src, duration, thumbCount, () => active, (i, url) => {
      if (active) setThumbs((prev) => prev.map((t, j) => (j === i ? url : t)));
    });
    return () => { active = false; };
  }, [src, duration, thumbCount]);

  // Keep the playhead in view on a zoomed strip.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !duration || scrubbingRef.current) return;
    const x = (time / duration) * strip.scrollWidth;
    if (x < strip.scrollLeft + 24 || x > strip.scrollLeft + strip.clientWidth - 24) strip.scrollLeft = x - strip.clientWidth / 2;
  }, [time, duration, zoom]);

  // A streamed file can report Infinity at first and its real length later.
  const readDuration = (e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : 0);
  const seek = (t) => {
    const video = videoRef.current;
    if (!video || !duration) return;
    const next = Math.min(Math.max(0, t), Math.max(0, duration - FRAME_SEC));
    video.currentTime = next;
    setTime(next);
  };
  const pause = () => { videoRef.current?.pause(); setPlaying(false); };
  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) { video.play()?.catch(() => setPlaying(false)); setPlaying(true); } else pause();
  };
  const seekFromPointer = (e) => {
    const inner = e.currentTarget.getBoundingClientRect();
    if (!inner.width) return;
    seek(((e.clientX - inner.left) / inner.width) * duration);
  };
  const isPicked = (t) => picked.some((p) => Math.abs(p - t) < FRAME_SEC / 2);
  const pick = () => {
    const t = Math.round(time * 1000) / 1000;
    if (isPicked(t) || picked.length >= MAX_PICKS) return;
    setPicked((prev) => [...prev, t].sort((a, b) => a - b));
  };

  const button = 'min-h-[44px] min-w-[40px] inline-flex items-center justify-center rounded text-gray-300 hover:text-white disabled:opacity-40';
  return (
    <Modal open usePortal size="3xl" onClose={onClose} ariaLabel="Pick frames" panelClassName="bg-port-card border border-port-border rounded-xl p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-white">Pick frames</h2>
        <button type="button" onClick={onClose} aria-label="Close frame picker" className={button}>
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>

      {/* reference clips have no caption track */}
      <video
        ref={videoRef}
        src={src}
        poster={poster || undefined}
        playsInline
        muted
        preload="auto"
        data-testid="frame-picker-video"
        onLoadedMetadata={readDuration}
        onDurationChange={readDuration}
        onTimeUpdate={(e) => { if (!scrubbingRef.current) setTime(e.currentTarget.currentTime); }}
        onPause={() => setPlaying(false)}
        onClick={togglePlay}
        className="w-full max-h-[50dvh] object-contain bg-black rounded"
      />

      <div className="flex items-center">
        <button type="button" onClick={() => { pause(); seek(time - FRAME_SEC); }} aria-label="Back one frame" className={button}>
          <ChevronLeft className="w-4 h-4" aria-hidden="true" />
        </button>
        <button type="button" onClick={togglePlay} aria-label={playing ? 'Pause' : 'Play'} className={button}>
          {playing ? <Pause className="w-4 h-4" aria-hidden="true" /> : <Play className="w-4 h-4" aria-hidden="true" />}
        </button>
        <button type="button" onClick={() => { pause(); seek(time + FRAME_SEC); }} aria-label="Forward one frame" className={button}>
          <ChevronRight className="w-4 h-4" aria-hidden="true" />
        </button>
        <span className="text-[11px] tabular-nums whitespace-nowrap text-gray-400">{formatFrameTime(time)} / {formatFrameTime(duration)}</span>
        <span className="ml-auto inline-flex items-center">
          <button type="button" onClick={() => setZoom((z) => ZOOMS[Math.max(0, ZOOMS.indexOf(z) - 1)])} disabled={zoom === ZOOMS[0]} aria-label="Zoom out of the filmstrip" className={button}>
            <ZoomOut className="w-4 h-4" aria-hidden="true" />
          </button>
          <span className="text-[11px] tabular-nums text-gray-400 w-5 text-center">{zoom}×</span>
          <button type="button" onClick={() => setZoom((z) => ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(z) + 1)])} disabled={zoom === ZOOMS.at(-1)} aria-label="Zoom into the filmstrip" className={button}>
            <ZoomIn className="w-4 h-4" aria-hidden="true" />
          </button>
        </span>
      </div>

      <div ref={stripRef} className="overflow-x-auto rounded border border-port-border bg-port-bg">
        <div
          role="slider"
          tabIndex={0}
          aria-label="Filmstrip"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration * 1000) / 1000}
          aria-valuenow={Math.round(time * 1000) / 1000}
          aria-valuetext={formatFrameTime(time)}
          data-testid="frame-picker-strip"
          className="relative flex touch-none select-none cursor-pointer"
          style={{ width: `${zoom * 100}%`, height: THUMB_HEIGHT }}
          onPointerDown={(e) => { pause(); scrubbingRef.current = true; e.currentTarget.setPointerCapture?.(e.pointerId); seekFromPointer(e); }}
          onPointerMove={(e) => { if (scrubbingRef.current) seekFromPointer(e); }}
          onPointerUp={() => { scrubbingRef.current = false; }}
          onPointerCancel={() => { scrubbingRef.current = false; }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); pause(); seek(time + (e.key === 'ArrowLeft' ? -FRAME_SEC : FRAME_SEC)); }
          }}
        >
          {thumbs.map((url, i) => (
            <div key={i} className="flex-1 min-w-0 h-full bg-port-card border-r border-port-bg/60 overflow-hidden">
              {url ? <img src={url} alt="" className="w-full h-full object-cover pointer-events-none" draggable={false} /> : null}
            </div>
          ))}
          {duration ? picked.map((t) => (
            <span key={t} className="absolute top-0 bottom-0 w-1 -ml-0.5 bg-port-success pointer-events-none" style={{ left: `${(t / duration) * 100}%` }} />
          )) : null}
          {duration ? (
            <span className="absolute top-0 bottom-0 w-1 -ml-0.5 bg-white ring-1 ring-black/60 pointer-events-none" style={{ left: `${(time / duration) * 100}%` }} />
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={pick}
          disabled={!duration || isPicked(time) || picked.length >= MAX_PICKS}
          className="min-h-[44px] inline-flex items-center gap-1.5 px-3 rounded bg-port-bg border border-port-border text-xs text-white hover:border-port-accent disabled:opacity-40"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> Pick this frame
        </button>
        {picked.map((t) => (
          <span key={t} className="inline-flex items-center rounded-full border border-port-border bg-port-bg text-xs text-gray-300">
            <button type="button" onClick={() => { pause(); seek(t); }} className="min-h-[36px] pl-3 pr-1 tabular-nums" aria-label={`Go to ${formatFrameTime(t)}`}>
              {formatFrameTime(t)}
            </button>
            <button type="button" onClick={() => setPicked((prev) => prev.filter((p) => p !== t))} className="min-h-[36px] min-w-[36px] inline-flex items-center justify-center text-gray-500 hover:text-port-error" aria-label={`Remove ${formatFrameTime(t)}`}>
              <X className="w-3 h-3" aria-hidden="true" />
            </button>
          </span>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => onAdd(picked)}
          disabled={!picked.length || busy}
          className="min-h-[44px] px-4 rounded bg-port-accent text-white text-sm font-medium disabled:opacity-40"
        >
          {busy ? 'Adding…' : picked.length ? `Add ${picked.length} frame${picked.length === 1 ? '' : 's'} to board` : 'Add frames to board'}
        </button>
      </div>
    </Modal>
  );
}
