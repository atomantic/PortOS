import { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Scissors } from 'lucide-react';

// Frame stepping still needs a rate when a clip recorded none; the server
// snaps the chosen time to the clip's real frame grid either way.
const FALLBACK_FPS = 24;

// The frame on screen at `sec`: frame n spans [n, n + 1) / fps.
const frameAt = (sec, rate) => Math.floor((Number(sec) || 0) * rate + 1e-6);

// Pick a later start frame on a playing clip and keep the clip from there.
// Shared by every surface that shows a video take (Video Gen result, music
// video clip takes): the host owns the <video> element and what a trim does,
// so `onTrim(startSec)` returns a promise and this control only shows the
// frame, steps it, and reports a failure inline. `sourceKey` names the clip
// on screen, so a host that swaps the element re-subscribes.
export default function VideoStartTrimControl({ videoRef, fps, onTrim, sourceKey, disabled = false }) {
  const rate = Number(fps) > 0 ? Number(fps) : FALLBACK_FPS;
  const [frame, setFrame] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  // The ref is filled at commit, so it is read here rather than during render.
  useEffect(() => {
    const video = videoRef?.current;
    if (!video) return undefined;
    const sync = () => setFrame(frameAt(video.currentTime, rate));
    sync();
    video.addEventListener('timeupdate', sync);
    video.addEventListener('seeked', sync);
    return () => {
      video.removeEventListener('timeupdate', sync);
      video.removeEventListener('seeked', sync);
    };
  }, [videoRef, rate, sourceKey]);

  const step = (delta) => {
    const el = videoRef?.current;
    if (!el) return;
    el.pause();
    const current = frameAt(el.currentTime, rate);
    const max = Number.isFinite(el.duration) ? Math.floor(el.duration * rate) : Infinity;
    const next = Math.min(max, Math.max(0, current + delta));
    // Aim at the middle of the frame so a rounding seek can't land on its neighbour.
    el.currentTime = (next + 0.5) / rate;
    setFrame(next);
  };

  const trim = async () => {
    const el = videoRef?.current;
    if (!el || saving) return;
    el.pause();
    setSaving(true);
    setError(null);
    // Send the frame's exact start so the server's snap lands on this frame.
    await Promise.resolve(onTrim(frameAt(el.currentTime, rate) / rate))
      .catch((err) => setError(err?.message || 'Trim failed'))
      .finally(() => setSaving(false));
  };

  const busy = disabled || saving;
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
      <button type="button" disabled={busy || frame < 1} onClick={trim}
        className="min-h-[44px] flex items-center gap-1.5 px-2 rounded bg-port-border text-sm text-port-text disabled:opacity-50">
        <Scissors className="w-3.5 h-3.5" /> {saving ? 'Trimming…' : 'Start clip here'}
      </button>
      {error && <p role="alert" className="w-full text-xs text-port-error">{error}</p>}
    </div>
  );
}
