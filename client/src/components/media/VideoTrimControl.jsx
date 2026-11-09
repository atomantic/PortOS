import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Scissors } from 'lucide-react';

// Frame stepping still needs a rate when a clip recorded none; the server
// snaps the chosen time to the clip's real frame grid either way.
const FALLBACK_FPS = 24;

// The frame on screen at `sec`: frame n spans [n, n + 1) / fps.
const frameAt = (sec, rate) => Math.floor((Number(sec) || 0) * rate + 1e-6);

// The clip's last frame index, or Infinity before its duration is known.
const lastFrameOf = (el, rate) => (Number.isFinite(el?.duration) && el.duration > 0
  ? Math.max(0, Math.ceil(el.duration * rate - 1e-6) - 1) : Infinity);

// Pick a frame on a playing clip and keep the clip from it ("Start clip here")
// or up to and including it ("End clip here"). Shared by every surface that
// shows a video take (Video Gen result, music video clip takes): the host owns
// the <video> element and what a trim does, so `onTrim({ startSec })` /
// `onTrim({ endSec })` returns a promise and this control only shows the frame,
// steps it, and reports a failure inline. `sourceKey` names the clip on
// screen, so a host that swaps the element re-subscribes.
export default function VideoTrimControl({ videoRef, fps, onTrim, sourceKey, disabled = false }) {
  const rate = Number(fps) > 0 ? Number(fps) : FALLBACK_FPS;
  const [frame, setFrame] = useState(0);
  const [lastFrame, setLastFrame] = useState(Infinity);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  // The ref is filled at commit, so it is read here rather than during render.
  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return undefined;
    const sync = () => {
      setFrame(frameAt(video.currentTime, rate));
      setLastFrame(lastFrameOf(video, rate));
    };
    sync();
    const events = ['timeupdate', 'seeked', 'loadedmetadata', 'durationchange'];
    for (const name of events) video.addEventListener(name, sync);
    return () => { for (const name of events) video.removeEventListener(name, sync); };
  }, [videoRef, rate, sourceKey]);

  const step = (delta) => {
    const el = videoRef?.current;
    if (!el) return;
    el.pause();
    const current = frameAt(el.currentTime, rate);
    const next = Math.min(lastFrameOf(el, rate), Math.max(0, current + delta));
    // Aim at the middle of the frame so a rounding seek can't land on its neighbour.
    el.currentTime = (next + 0.5) / rate;
    setFrame(next);
  };

  const trim = async (edge) => {
    const el = videoRef?.current;
    if (!el || saving) return;
    el.pause();
    setSaving(edge);
    setError(null);
    // Send exact frame boundaries so the server's snap lands on this frame:
    // a start keeps this frame, an end keeps it as the last one.
    const current = frameAt(el.currentTime, rate);
    const range = edge === 'start' ? { startSec: current / rate } : { endSec: (current + 1) / rate };
    await Promise.resolve(onTrim(range))
      .catch((err) => setError(err?.message || 'Trim failed'))
      .finally(() => setSaving(null));
  };

  const busy = disabled || !!saving;
  const buttonClass = 'min-h-[44px] flex items-center gap-1.5 px-2 rounded bg-port-border text-sm text-port-text disabled:opacity-50';
  return (
    <div className="w-full flex flex-wrap items-center gap-2">
      <button type="button" aria-label="Previous frame" disabled={busy} onClick={() => step(-1)}
        className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded bg-port-border text-white disabled:opacity-50">
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="text-xs text-gray-300 tabular-nums min-w-[4.5rem] text-center">Frame {frame}</span>
      <button type="button" aria-label="Next frame" disabled={busy} onClick={() => step(1)}
        className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded bg-port-border text-white disabled:opacity-50">
        <ChevronRight className="w-4 h-4" />
      </button>
      <button type="button" disabled={busy || frame < 1} onClick={() => trim('start')} className={buttonClass}>
        <Scissors className="w-3.5 h-3.5" /> {saving === 'start' ? 'Trimming…' : 'Start clip here'}
      </button>
      <button type="button" disabled={busy || frame >= lastFrame} onClick={() => trim('end')} className={buttonClass}>
        <Scissors className="w-3.5 h-3.5 -scale-x-100" /> {saving === 'end' ? 'Trimming…' : 'End clip here'}
      </button>
      {error && <p role="alert" className="w-full text-xs text-port-error">{error}</p>}
    </div>
  );
}
