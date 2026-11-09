import { useState } from 'react';
import { FAL_IMAGE_VIDEO_MODELS } from '../../lib/falVideoModels.js';
import { RUNWAY_VIDEO_MODELS } from '../../lib/runwayVideoModels.js';
import { CLIP_LENGTH_SEC_RANGE, clipLengthChoices, falSceneTake, runwaySceneTake } from '../../lib/musicVideoShotTiming.js';

const FIELD = 'bg-port-bg border border-port-border rounded px-1 py-1 text-base sm:text-xs min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50';

/**
 * A shot's own source clip length and video model, apart from its span on the
 * timeline: one take cut across several shots needs a clip longer than its first
 * piece. Blank length follows the span; model "Project default" follows the
 * project. `settings` is the renderer the render uses; the project's own
 * settings are never written. `onChange(patch)` saves `{ clipLengthSec }` or `{ clipModelId }`.
 */
export default function SceneClipLength({ fieldId, scene, settings = {}, disabled = false, onChange }) {
  const [draft, setDraft] = useState(null);
  const backend = settings?.backend || null;
  const models = backend === 'fal' ? FAL_IMAGE_VIDEO_MODELS : backend === 'runway' ? RUNWAY_VIDEO_MODELS : [];
  const modelId = backend === 'fal' ? falSceneTake({ scene, videoSettings: settings }).modelId
    : backend === 'runway' ? runwaySceneTake({ scene, videoSettings: settings }).modelId : null;
  const choices = clipLengthChoices(backend, modelId);
  const wanted = Number.isFinite(scene.clipLengthSec) ? scene.clipLengthSec : null;
  const snapped = wanted != null ? choices.find((sec) => sec >= wanted - 1e-6) ?? null : null;
  const commit = (raw) => {
    setDraft(null);
    const next = raw.trim() === '' ? null : Number(raw);
    if (next != null && !(next >= CLIP_LENGTH_SEC_RANGE.min && next <= CLIP_LENGTH_SEC_RANGE.max)) return;
    if (next !== wanted) onChange({ clipLengthSec: next });
  };
  let readout = 'follows the shot';
  if (wanted != null && choices.length) {
    readout = snapped != null ? `renders ${snapped} s` : `no length reaches ${wanted} s — longest is ${choices[choices.length - 1]} s`;
  } else if (wanted != null) readout = 'this renderer sizes by frames';
  return (
    <div className="space-y-1 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={fieldId('clip-length')} className="w-20">Source clip</label>
        <input id={fieldId('clip-length')} type="number" inputMode="decimal" min={CLIP_LENGTH_SEC_RANGE.min} max={CLIP_LENGTH_SEC_RANGE.max} step="0.25"
          value={draft ?? (wanted ?? '')} disabled={disabled} placeholder="auto" onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          className={`w-20 tabular-nums ${FIELD}`} />
        <span className="text-port-text-muted">seconds, {readout}</span>
      </div>
      {models.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={fieldId('clip-model')} className="w-20">Video model</label>
          <select id={fieldId('clip-model')} value={scene.clipModelId || ''} disabled={disabled} onChange={(e) => onChange({ clipModelId: e.target.value || null })}
            className={`max-w-full ${FIELD}`}>
            <option value="">Project default</option>
            {models.map((model) => <option key={model.id} value={model.id}>{model.label || model.id}</option>)}
          </select>
        </div>
      )}
    </div>
  );
}
