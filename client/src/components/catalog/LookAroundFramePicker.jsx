import { useEffect, useId, useRef, useState } from 'react';
import { Check, Loader2, Plus, X } from 'lucide-react';
import toast from '../ui/Toast';
import { formatCount } from '../../utils/formatters';
import { saveCatalogLookAroundAngles, scoreCatalogLookAroundClip } from '../../services/apiCatalog';
import { lookAroundAngleLabel } from '../../../../server/lib/catalogLookAround.js';

const FIELD = 'rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-white min-h-[44px] sm:min-h-0';
const BUTTON = 'inline-flex items-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50';
const nearest = (frames, atSec) => frames.reduce((best, f) => (Math.abs(f.atSec - atSec) < Math.abs(best.atSec - atSec) ? f : best), frames[0]);

/**
 * Pick angles from one look-around clip: a scrubber over the clip, a strip of the sharpest frames
 * across its sweep (blur score per frame), and the kept list with editable bearing and name. Saving is
 * the only step that adds anything to the place; the clean-up option previews its edit prompt first.
 */
export default function LookAroundFramePicker({ ingredientId, clip, readOnly = false, onSaved }) {
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [atSec, setAtSec] = useState(0);
  const [kept, setKept] = useState([]);
  const [cleanup, setCleanup] = useState(false);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);
  const videoRef = useRef(null);
  const scrubId = useId();
  const cleanupId = useId();

  useEffect(() => {
    let active = true;
    scoreCatalogLookAroundClip(ingredientId, clip.id, { silent: true })
      .then((result) => { if (active) setAnalysis(result); })
      .catch((err) => { if (active) setError(err?.message || 'Could not read the clip'); });
    return () => { active = false; };
  }, [ingredientId, clip.id]);

  const seek = (t) => {
    setAtSec(t);
    if (videoRef.current) videoRef.current.currentTime = t;
  };
  const isKept = (t) => kept.some((angle) => Math.abs(angle.atSec - t) < 0.01);
  const toggle = (frame) => {
    setPreview(null);
    setKept((prev) => (isKept(frame.atSec) ? prev.filter((angle) => Math.abs(angle.atSec - frame.atSec) >= 0.01)
      : [...prev, { atSec: frame.atSec, bearingDeg: frame.bearingDeg, name: '' }].sort((a, b) => a.atSec - b.atSec)));
  };
  const edit = (index, patch) => { setPreview(null); setKept((prev) => prev.map((angle, i) => (i === index ? { ...angle, ...patch } : angle))); };
  const submit = (dryRun) => saveCatalogLookAroundAngles(ingredientId, clip.id, {
    angles: kept.map(({ atSec: t, bearingDeg, name }) => ({ atSec: t, bearingDeg: Number(bearingDeg) % 360, ...(name.trim() ? { name: name.trim() } : {}) })),
    cleanup, dryRun,
  }, { silent: true });
  const save = async (dryRun) => {
    setSaving(true);
    const result = await submit(dryRun).catch((err) => { toast.error(err?.message || 'Could not keep these angles'); return null; });
    setSaving(false);
    if (!result) return;
    if (dryRun) { setPreview(result); return; }
    toast.success(`Kept ${formatCount(result.angles.length)} ${result.angles.length === 1 ? 'angle' : 'angles'} as plates${result.cleanupJobs.length ? '; sharpened copies are rendering' : ''}.`);
    setKept([]);
    setPreview(null);
    onSaved?.();
  };

  if (error) return <p role="alert" className="text-xs text-port-error">{error}</p>;
  if (!analysis) return <p className="text-xs text-gray-400 flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> Scoring the clip&apos;s frames…</p>;
  const here = nearest(analysis.frames, atSec);
  const turnNote = analysis.directionSource === 'frames' && analysis.requestedDirection && analysis.direction !== analysis.requestedDirection
    ? `The camera turned ${analysis.direction}, not ${analysis.requestedDirection} as asked; angles are labelled from the frames.`
    : analysis.directionSource === 'prompt' ? 'The turn was too small to read from the frames; angles are placed by time.' : null;

  return (
    <div className="space-y-3 rounded border border-port-border bg-port-bg p-3">
      <video ref={videoRef} src={`/data/videos/${encodeURIComponent(clip.filename)}`} muted playsInline preload="metadata"
        className="w-full max-h-80 rounded bg-black object-contain" />
      <div>
        <label htmlFor={scrubId} className="block text-xs text-gray-400 mb-1">
          {atSec.toFixed(2)}s · {lookAroundAngleLabel({ motion: analysis.motion, bearingDeg: here.bearingDeg, progress: here.progress })} · sharpness {Math.round(here.sharpness * 100)}
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <input id={scrubId} type="range" min="0" max={analysis.durationSec} step="0.05" value={atSec}
            onChange={(e) => seek(Number(e.target.value))} className="min-w-0 flex-1" />
          {!readOnly && (
            <button type="button" className={BUTTON} disabled={isKept(atSec)}
              onClick={() => toggle({ atSec: Math.round(atSec * 1000) / 1000, bearingDeg: here.bearingDeg })}>
              <Plus size={14} aria-hidden="true" /> Keep this moment
            </button>
          )}
        </div>
      </div>
      {turnNote && <p className="text-xs text-port-warning">{turnNote}</p>}
      <div>
        <h4 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Sharpest frames around the turn</h4>
        <ul className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
          {analysis.strip.map((frame) => (
            <li key={frame.atSec} className="min-w-0">
              <button type="button" onClick={() => { seek(frame.atSec); if (!readOnly) toggle(frame); }} aria-pressed={isKept(frame.atSec)}
                className={`w-full rounded border p-1 text-left text-[11px] ${isKept(frame.atSec) ? 'border-port-accent' : 'border-port-border'} hover:border-port-accent`}>
                <img src={frame.thumb} alt="" className="aspect-video w-full rounded bg-black object-cover" />
                <span className="flex items-center gap-1 text-gray-300">{isKept(frame.atSec) && <Check size={11} aria-hidden="true" />}{frame.label}</span>
                <span className="block h-1 rounded bg-port-border" aria-hidden="true">
                  <span className="block h-1 rounded bg-port-accent" style={{ width: `${Math.round(frame.sharpness * 100)}%` }} />
                </span>
                <span className="block text-gray-500">{frame.atSec.toFixed(2)}s · sharpness {Math.round(frame.sharpness * 100)}</span>
              </button>
            </li>
          ))}
        </ul>
        {!analysis.strip.length && <p className="text-xs text-gray-500">No frame is sharp enough to suggest; scrub to a moment and keep it.</p>}
      </div>
      {!readOnly && kept.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-xs uppercase tracking-wider text-gray-500">Angles to keep</h4>
          <ul className="space-y-2">
            {kept.map((angle, index) => (
              <li key={angle.atSec} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-gray-400 w-14">{angle.atSec.toFixed(2)}s</span>
                <label htmlFor={`${scrubId}-bearing-${index}`} className="text-gray-400">Bearing</label>
                <input id={`${scrubId}-bearing-${index}`} type="number" min="0" max="359" step="5" className={`${FIELD} w-20`} value={angle.bearingDeg}
                  onChange={(e) => edit(index, { bearingDeg: e.target.value })} />
                <span className="text-gray-300">{lookAroundAngleLabel({ motion: analysis.motion, bearingDeg: Number(angle.bearingDeg), progress: angle.atSec / analysis.durationSec })}</span>
                <label htmlFor={`${scrubId}-name-${index}`} className="sr-only">Name</label>
                <input id={`${scrubId}-name-${index}`} type="text" maxLength={80} placeholder="Name (optional)" className={`${FIELD} min-w-0 flex-1`} value={angle.name}
                  onChange={(e) => edit(index, { name: e.target.value })} />
                <button type="button" aria-label={`Drop the angle at ${angle.atSec.toFixed(2)}s`} onClick={() => toggle(angle)}
                  className="min-h-[44px] min-w-[44px] sm:min-h-8 sm:min-w-8 rounded border border-port-border flex items-center justify-center">
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <div className="flex items-center gap-2 text-xs">
            <input id={cleanupId} type="checkbox" checked={cleanup} onChange={(e) => { setCleanup(e.target.checked); setPreview(null); }} />
            <label htmlFor={cleanupId} className="text-gray-300">Also add a sharpened copy of each (an image edit told to change nothing but sharpness)</label>
          </div>
          {preview?.cleanup && (
            <details open className="text-xs">
              <summary className="cursor-pointer text-gray-400">Clean-up prompt ({preview.cleanup.mode})</summary>
              <p className="text-gray-500">{preview.cleanup.inputNote}</p>
              <pre className="whitespace-pre-wrap break-words text-gray-300">{preview.cleanup.sentPrompt}</pre>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            {cleanup && (
              <button type="button" className={BUTTON} disabled={saving} onClick={() => save(true)}>Preview clean-up prompt</button>
            )}
            <button type="button" className={`${BUTTON} bg-port-accent/20 text-port-accent`} disabled={saving || (cleanup && !preview)} onClick={() => save(false)}>
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Keep {formatCount(kept.length)} {kept.length === 1 ? 'angle' : 'angles'} as plates
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
