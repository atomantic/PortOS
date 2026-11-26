import { useCallback, useEffect, useId, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Compass, Loader2 } from 'lucide-react';
import toast from '../ui/Toast';
import socket from '../../services/socket';
import MediaImage from '../MediaImage';
import LookAroundFramePicker from './LookAroundFramePicker';
import { getCatalogLookAround, startCatalogLookAround } from '../../services/apiCatalog';
import { useMediaCompletionRefresh } from '../../hooks/useMediaCompletionRefresh';
import { formatDateTime, formatUsd } from '../../utils/formatters';

const FIELD = 'w-full rounded border border-port-border bg-port-bg px-2 py-1 text-sm text-white min-h-[44px] pointer-fine:sm:min-h-0';
const BUTTON = 'inline-flex items-center gap-1 rounded border border-port-border px-3 py-1.5 text-sm min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50';
export const priceText = (usd) => (usd == null ? 'an unknown price' : formatUsd(usd));

/**
 * "Look around" on a place's Plates tab (#16145): render one locked-tripod pan from the main plate,
 * after showing its exact prompt and price, then pick sharp frames from it as matching angle plates.
 * The open clip is the `lookAround` search param, so a picker is deep-linkable.
 */
export default function LookAroundPanel({ ingredientId, media, readOnly = false, onSaved }) {
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState({ sourceImage: '', motion: '', modelId: '', seconds: '', resolution: '' });
  // null = PortOS's prompt for the motion; a string = the director's own words, sent as written.
  const [prompt, setPrompt] = useState(null);
  const [plan, setPlan] = useState(null);
  const [working, setWorking] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const clipId = searchParams.get('lookAround');
  const ids = { source: useId(), motion: useId(), model: useId(), seconds: useId(), resolution: useId(), prompt: useId() };

  const load = useCallback(() => getCatalogLookAround(ingredientId, { silent: true })
    .then((next) => { setInfo(next); setLoadError(null); return next; })
    .catch((err) => { setLoadError(err?.message || 'Could not load look-around clips'); return null; }), [ingredientId]);

  useEffect(() => {
    let active = true;
    getCatalogLookAround(ingredientId, { silent: true })
      .then((next) => { if (active) { setInfo(next); setLoadError(null); } })
      .catch((err) => { if (active) setLoadError(err?.message || 'Could not load look-around clips'); });
    return () => { active = false; };
  }, [ingredientId]);
  useMediaCompletionRefresh({ onVideoCompleted: load });
  useEffect(() => {
    const onFailed = () => { load(); };
    socket.on('video-gen:failed', onFailed);
    return () => { socket.off('video-gen:failed', onFailed); };
  }, [load]);

  const images = (Array.isArray(media) ? media : []).filter((m) => !m.deleted && (m.kind === 'portrait' || m.kind === 'reference'));
  const motion = form.motion || info?.defaults?.motion || 'full-turn';
  const modelId = form.modelId || info?.defaults?.modelId || '';
  const model = info?.models?.find((m) => m.id === modelId);
  const motionInfo = info?.motions?.find((m) => m.id === motion);
  const change = (patch) => { setForm((prev) => ({ ...prev, ...patch })); setPlan(null); };
  const body = (dryRun) => ({
    motion, ...(modelId ? { modelId } : {}), dryRun,
    ...(form.sourceImage ? { sourceImage: form.sourceImage } : {}),
    ...(form.seconds ? { seconds: Number(form.seconds) } : {}),
    ...(form.resolution ? { resolution: form.resolution } : {}),
    ...(prompt !== null ? { prompt } : {}),
  });
  const call = async (dryRun) => {
    setWorking(true);
    const result = await startCatalogLookAround(ingredientId, body(dryRun), { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not plan the look-around');
      return null;
    });
    setWorking(false);
    return result;
  };
  const preview = async () => { const result = await call(true); if (result) setPlan(result); };
  const render = async () => {
    const result = await call(false);
    if (!result) return;
    toast.success(`Rendering the look-around clip for ${priceText(result.estimatedCostUsd)}. Nothing is added to this place until you keep frames.`);
    setPlan(null);
    setInfo((prev) => (prev ? { ...prev, pending: [...prev.pending, { jobId: result.jobId, status: 'queued', motion: result.motion }] } : prev));
  };
  const openClip = (id) => {
    const next = new URLSearchParams(searchParams);
    if (id) next.set('lookAround', id); else next.delete('lookAround');
    setSearchParams(next);
  };
  const openedClip = info?.clips?.find((clip) => clip.id === clipId) || null;

  return (
    <section className="bg-port-card border border-port-border rounded-lg p-4 space-y-4" aria-label="Look around">
      <div>
        <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
          <Compass size={14} aria-hidden="true" /> Look around
        </h2>
        <p className="text-xs text-gray-400 mt-1">One slow tripod pan from a plate keeps the same geometry and light all the way round, so frames from it make matching camera angles.</p>
      </div>
      {loadError && <p role="alert" className="text-xs text-port-error">{loadError}</p>}
      {info && !readOnly && (
        <div className="space-y-3">
          {!images.length && <p className="text-xs text-gray-500">Add a plate to this place first.</p>}
          <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor={ids.source} className="block text-xs text-gray-400 mb-1">From plate</label>
              <select id={ids.source} className={FIELD} value={form.sourceImage || info.mainPlate || ''} onChange={(e) => change({ sourceImage: e.target.value })}>
                {images.map((m) => <option key={`${m.mediaKey}:${m.kind}`} value={m.mediaKey}>{m.library?.variant?.label || m.caption || m.mediaKey}{m.mediaKey === info.mainPlate ? ' (main plate)' : ''}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={ids.motion} className="block text-xs text-gray-400 mb-1">Camera move</label>
              <select id={ids.motion} className={FIELD} value={motion} onChange={(e) => { change({ motion: e.target.value, seconds: '' }); setPrompt(null); }}>
                {info.motions.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={ids.model} className="block text-xs text-gray-400 mb-1">Model</label>
              <select id={ids.model} className={FIELD} value={modelId} onChange={(e) => change({ modelId: e.target.value, resolution: '' })}>
                {info.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor={ids.seconds} className="block text-xs text-gray-400 mb-1">Length (seconds)</label>
              <input id={ids.seconds} type="number" min="1" max="60" step="1" className={FIELD} placeholder={String(motionInfo?.defaultSec ?? '')}
                value={form.seconds} onChange={(e) => change({ seconds: e.target.value })} />
            </div>
            {model?.resolutions?.length > 0 && (
              <div>
                <label htmlFor={ids.resolution} className="block text-xs text-gray-400 mb-1">Resolution</label>
                <select id={ids.resolution} className={FIELD} value={form.resolution || model.defaultResolution || ''} onChange={(e) => change({ resolution: e.target.value })}>
                  {model.resolutions.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            )}
          </div>
          <p className="text-xs text-gray-500">A slower turn keeps frames sharp: a full turn in 8 seconds blurs at its fastest point, so a full turn defaults to 15 seconds. Two half turns are another way to cover every side.</p>
          {plan && (
            <div className="space-y-2 rounded border border-port-border bg-port-bg p-3 text-xs">
              <p className="text-white">{plan.modelLabel}: {plan.seconds}s{plan.resolution ? ` at ${plan.resolution}` : ''}, about {priceText(plan.estimatedCostUsd)}</p>
              {!plan.configured && <p className="text-port-warning">Add a fal.ai API key in Settings → Credentials to render.</p>}
              <label htmlFor={ids.prompt} className="block text-gray-400">Prompt {plan.promptIsDefault ? '(written by PortOS for this move; edit to send your own)' : '(your words, sent as written)'}</label>
              <textarea id={ids.prompt} rows={5} maxLength={20000} className={`${FIELD} text-xs`} value={prompt ?? plan.prompt}
                onChange={(e) => { setPrompt(e.target.value); setPlan((prev) => (prev ? { ...prev, stale: true } : prev)); }} />
              <details>
                <summary className="cursor-pointer text-gray-400">Show full request</summary>
                <pre className="whitespace-pre-wrap break-words text-gray-300">{JSON.stringify(plan.body, null, 2)}</pre>
              </details>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} disabled={working || !images.length} onClick={preview}>
              {working && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} Preview prompt and price
            </button>
            <button type="button" className={`${BUTTON} bg-port-accent/20 text-port-accent`} disabled={working || !plan || plan.stale || !plan.configured} onClick={render}
              title={plan?.stale ? 'Preview again after editing the prompt' : undefined}>
              {plan && !plan.stale ? `Render for ${priceText(plan.estimatedCostUsd)}` : 'Preview first'}
            </button>
          </div>
        </div>
      )}
      {info?.pending?.length > 0 && (
        <ul className="text-xs text-gray-400 space-y-1" aria-label="Look-around renders in progress">
          {info.pending.map((job) => (
            <li key={job.jobId} className="flex items-center gap-1"><Loader2 size={12} className="animate-spin" aria-hidden="true" /> {job.motion || 'Look-around'} clip {job.status}</li>
          ))}
        </ul>
      )}
      {info?.clips?.length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wider text-gray-500 mb-2">Clips</h3>
          <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {info.clips.map((clip) => (
              <li key={clip.id}>
                <button type="button" onClick={() => openClip(clip.id === clipId ? null : clip.id)} aria-pressed={clip.id === clipId}
                  className={`w-full rounded border p-1 text-left text-xs ${clip.id === clipId ? 'border-port-accent' : 'border-port-border'} hover:border-port-accent`}>
                  <MediaImage thumbnail src={`/data/images/${encodeURIComponent(clip.sourceMediaKey)}`} alt="" className="aspect-video w-full rounded bg-black object-cover" />
                  <span className="block mt-1 text-gray-300">{info.motions.find((m) => m.id === clip.motion)?.label || clip.motion}</span>
                  <span className="block text-gray-500">{formatDateTime(clip.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {clipId && info && !openedClip && <p className="text-xs text-port-warning">That look-around clip is not on this place.</p>}
      {openedClip && (
        <LookAroundFramePicker key={openedClip.id} ingredientId={ingredientId} clip={openedClip} readOnly={readOnly}
          onSaved={() => { onSaved?.(); }} />
      )}
    </section>
  );
}
