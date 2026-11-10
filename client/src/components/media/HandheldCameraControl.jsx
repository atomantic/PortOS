import { useEffect, useMemo, useRef, useState } from 'react';
import { Dices, Video } from 'lucide-react';
import { getVideoHistoryItem } from '../../services/apiImageVideo.js';
import {
  HANDHELD_CONTROLS, HANDHELD_DEFAULTS, HANDHELD_SEED_MAX, handheldCssTransform, handheldTerms, handheldZoom, normalizeHandheld,
} from '../../../../server/lib/handheldCamera.js';

const randomSeed = () => 1 + Math.floor(Math.random() * HANDHELD_SEED_MAX);
const buttonClass = 'min-h-[44px] flex items-center gap-1.5 px-2 rounded bg-port-border text-sm text-port-text disabled:opacity-50';

// Handheld camera for a clip: sliders for how unsteady the hands are and how
// much the operator walks, a re-roll for a different take of the same feel,
// and a live preview of the steady original moving the way the baked take
// will (lib/handheldCamera.js). The host owns what applying does:
// `onApply({ shake, steps, seed })` returns a promise. A clip that is already
// a handheld take previews and re-shoots its steady original with its own
// settings as the starting point, so shakes never stack.
export default function HandheldCameraControl({ clipId, onApply, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState(() => ({ ...HANDHELD_DEFAULTS, seed: randomSeed() }));
  const [source, setSource] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [retry, setRetry] = useState(0);
  const videoRef = useRef(null);

  // The steady clip to preview, and a handheld take's own settings to start from.
  useEffect(() => {
    if (!open || !clipId) return undefined;
    let live = true;
    setSource(null);
    setLoadError(null);
    (async () => {
      const item = await getVideoHistoryItem(clipId, { silent: true }).catch(() => null);
      const original = item?.handheldFrom ? await getVideoHistoryItem(item.handheldFrom, { silent: true }).catch(() => null) : null;
      if (!live) return;
      const steady = item?.handheldFrom ? original : item;
      if (!steady?.filename) {
        setLoadError(item?.handheldFrom ? 'Could not load the steady original. Retry before making a handheld take.' : 'Could not load the clip. Retry before making a handheld take.');
        return;
      }
      if (item?.handheld) setSettings(normalizeHandheld(item.handheld));
      setSource(steady?.filename ? `/data/videos/${encodeURIComponent(steady.filename)}` : null);
    })();
    return () => { live = false; };
  }, [open, clipId, retry]);

  // The clip's own shape, so the preview frames and zooms it as handheldFfmpegFilter will.
  const [aspect, setAspect] = useState(16 / 9);
  const terms = useMemo(() => handheldTerms(settings), [settings]);
  const zoom = useMemo(() => handheldZoom(terms, aspect), [terms, aspect]);

  // Drive the preview from the clip's own clock, so a pause or a scrub holds the matching frame.
  useEffect(() => {
    const video = videoRef.current;
    if (!open || !video) return undefined;
    let frame = 0;
    const draw = () => {
      video.style.transform = handheldCssTransform(terms, video.currentTime || 0, zoom) || '';
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [open, terms, zoom, source]);

  const set = (key, value) => setSettings((prev) => ({ ...prev, [key]: value }));
  const still = settings.shake <= 0 && settings.steps <= 0;
  const apply = async () => {
    if (saving || still || !source) return;
    videoRef.current?.pause();
    setSaving(true);
    setError(null);
    await Promise.resolve(onApply(settings))
      .then((ok) => { if (ok !== false) setOpen(false); })
      .catch((err) => setError(err?.message || 'Handheld camera failed'))
      .finally(() => setSaving(false));
  };

  if (!open) {
    return (
      <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={buttonClass}
        title="Re-shoot this clip as if a person were holding the camera">
        <Video className="w-3.5 h-3.5" /> Handheld camera…
      </button>
    );
  }
  return (
    <div className="w-full space-y-2 rounded border border-port-border p-2">
      {/* The width follows a 60vh height cap, so a tall clip keeps its own shape instead of being cropped. */}
      <div className="relative mx-auto max-w-full overflow-hidden rounded bg-black" style={{ aspectRatio: aspect, width: `min(100%, calc(60vh * ${aspect}))` }}>
        {source
          ? <video ref={videoRef} src={source} className="block w-full h-full object-cover" muted playsInline loop autoPlay controls={false}
            onLoadedMetadata={(e) => { const { videoWidth: w, videoHeight: h } = e.currentTarget; if (w > 0 && h > 0) setAspect(w / h); }} />
          : <p className="p-2 text-xs text-port-text-muted">{loadError ? 'Clip unavailable' : 'Loading the clip…'}</p>}
      </div>
      {HANDHELD_CONTROLS.map((control) => (
        <label key={control.id} className="flex items-center gap-2 text-xs" title={control.hint}>
          <span className="w-24 shrink-0 tabular-nums text-port-text-muted">{control.label} {Math.round(settings[control.id] * 100)}%</span>
          <input type="range" min="0" max="1" step="0.05" value={settings[control.id]} disabled={saving}
            onChange={(e) => set(control.id, Number(e.target.value))}
            className="min-w-0 flex-1 accent-port-accent min-h-[44px] pointer-fine:sm:min-h-0" />
        </label>
      ))}
      <p className="text-xs text-port-text-muted">
        Zooms in {Math.round((zoom - 1) * 100)}% to make room for the movement. The new take keeps the clip&apos;s length and sound.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={saving} onClick={() => set('seed', randomSeed())} className={buttonClass}
          title="Same amount of shake, a different path for it">
          <Dices className="w-3.5 h-3.5" /> New shake
        </button>
        <button type="button" disabled={disabled || saving || still || !source} onClick={apply}
          className="min-h-[44px] flex items-center gap-1.5 px-2 rounded bg-port-accent text-sm text-white disabled:opacity-50">
          <Video className="w-3.5 h-3.5" /> {saving ? 'Making handheld take…' : 'Make handheld take'}
        </button>
        <button type="button" disabled={saving} onClick={() => setOpen(false)} className={buttonClass}>Cancel</button>
      </div>
      {loadError && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-xs text-port-error">{loadError}</p><button type="button" className={buttonClass} onClick={() => setRetry((n) => n + 1)}>Retry</button></div>}
      {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
    </div>
  );
}
