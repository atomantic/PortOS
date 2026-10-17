import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ImageDown } from 'lucide-react';
import toast from '../ui/Toast';
import { shouldIgnoreGlobalKey } from '../../lib/a11yKeyboard.js';
import { uploadGalleryImage } from '../../services/apiSystem.js';

export const PREVIEW_FPS = 24;

/** The song frame at `t` seconds: the frame whose span holds it. */
export const frameAt = (t, fps = PREVIEW_FPS) => Math.max(0, Math.floor((Number(t) || 0) * fps + 1e-6));

/** Where a seek to frame `frame` lands: the middle of that frame, so it shows and reads back as that frame. */
export const frameTime = (frame, fps = PREVIEW_FPS) => (Math.max(0, Math.round(frame)) + 0.5) / fps;

/** `m:ss:ff` for a song frame. */
export function frameTimecode(frame, fps = PREVIEW_FPS) {
  const whole = Math.floor(frame / fps);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}:${String(frame % fps).padStart(String(fps - 1).length, '0')}`;
}

/**
 * The picture a video (at its current time) or an image element shows, as a PNG
 * blob; null when it has nothing decoded yet.
 */
export function captureMediaFrame(el) {
  const width = el?.videoWidth || el?.naturalWidth || 0;
  const height = el?.videoHeight || el?.naturalHeight || 0;
  if (!width || !height || (el.tagName === 'VIDEO' && el.readyState < 2)) return Promise.resolve(null);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')?.drawImage(el, 0, 0);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

const buttonCls = 'flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center gap-1 rounded border border-port-border bg-port-bg px-1 text-port-text disabled:opacity-40 sm:min-h-[28px] sm:min-w-[28px]';
const inputCls = 'min-h-[44px] rounded border border-port-border bg-port-bg px-1 text-right tabular-nums text-port-text sm:min-h-[28px]';

/**
 * Frame-by-frame controls for a preview player: step back or forward by a
 * chosen number of frames, type a song frame number to jump to it, and read its
 * timecode. `onSeek(songSec)` must pause the player and move it. With
 * `capture` (an async function returning a blob or `{ blob, time, fps, label }`),
 * Save frame puts that picture in the image gallery. Metadata identifies the frozen frame. `keys` binds "," and "."
 * on the page to the step buttons.
 */
export default function FrameStepper({ time, onSeek, fps = PREVIEW_FPS, maxSec = null, disabled = false, keys = false, capture = null, label = '', className = '' }) {
  const ids = useId();
  const frame = frameAt(time, fps);
  const lastFrame = Number.isFinite(maxSec) && maxSec > 0 ? Math.max(0, Math.ceil(maxSec * fps) - 1) : null;
  const [step, setStep] = useState(1);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const stepBy = Math.max(1, Math.floor(Number(step) || 1));
  const go = (target) => {
    const clamped = Math.max(0, lastFrame == null ? target : Math.min(lastFrame, target));
    onSeek(frameTime(clamped, fps));
  };
  const latest = useRef(null);
  latest.current = { frame, stepBy, go, disabled };
  useEffect(() => {
    if (!keys) return undefined;
    const onKey = (event) => {
      if (event.key !== ',' && event.key !== '.') return;
      if (shouldIgnoreGlobalKey(event, { ignoreRepeat: false }) || event.target?.closest?.('audio, video, input')) return;
      const current = latest.current;
      if (current.disabled) return;
      event.preventDefault();
      current.go(current.frame + (event.key === '.' ? current.stepBy : -current.stepBy));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [keys]);
  const save = async () => {
    setSaving(true);
    let captureError = null;
    const captured = await capture().catch((error) => { captureError = error; return null; });
    const blob = captured?.blob ?? captured;
    const saved = blob ? await uploadGalleryImage(blob, { silent: true }).catch(() => null) : null;
    setSaving(false);
    const capturedFrame = Number.isFinite(captured?.time) ? frameAt(captured.time, captured.fps || fps) : frame;
    const name = [captured?.label ?? label, `frame ${capturedFrame}`].filter(Boolean).join(' · ');
    if (saved?.filename) toast.success(`Saved ${name} to the image gallery`);
    else toast.error(`Couldn't save ${name}${captureError?.message ? `: ${captureError.message}` : ''}`);
  };
  return (
    <div className={`flex min-w-0 flex-wrap items-center gap-1.5 text-[11px] text-port-text-muted ${className}`}>
      <button type="button" onClick={() => go(frame - stepBy)} disabled={disabled || frame <= 0} aria-label={`Back ${stepBy} ${stepBy === 1 ? 'frame' : 'frames'}`} title="Back (,)" className={buttonCls}>
        <ChevronLeft size={14} aria-hidden="true" />
      </button>
      <label htmlFor={`${ids}-step`} className="sr-only">Frames per step</label>
      <input
        id={`${ids}-step`}
        type="number"
        inputMode="numeric"
        min={1}
        value={step}
        onChange={(e) => setStep(e.target.value)}
        onBlur={() => setStep(stepBy)}
        title="Frames per step"
        className={`${inputCls} w-12`}
      />
      <button type="button" onClick={() => go(frame + stepBy)} disabled={disabled || (lastFrame != null && frame >= lastFrame)} aria-label={`Forward ${stepBy} ${stepBy === 1 ? 'frame' : 'frames'}`} title="Forward (.)" className={buttonCls}>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
      <label htmlFor={`${ids}-frame`} className="whitespace-nowrap">Frame</label>
      <input
        id={`${ids}-frame`}
        type="number"
        inputMode="numeric"
        min={0}
        value={draft ?? frame}
        disabled={disabled}
        onFocus={() => setDraft(String(frame))}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          const typed = Math.floor(Number(draft));
          if (Number.isFinite(typed)) go(typed);
          setDraft(null);
          e.currentTarget.blur();
        }}
        onBlur={() => setDraft(null)}
        className={`${inputCls} w-20`}
      />
      <span className="whitespace-nowrap tabular-nums">{frameTimecode(frame, fps)}</span>
      {capture && (
        <button type="button" onClick={save} disabled={disabled || saving} title="Save this frame to the image gallery" className={`${buttonCls} px-2`}>
          <ImageDown size={14} aria-hidden="true" /> {saving ? 'Saving…' : 'Save frame'}
        </button>
      )}
    </div>
  );
}
