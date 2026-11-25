import { sceneButtonClass as BUTTON } from './controlClasses.js';
import { useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Film } from 'lucide-react';
import {
  defaultSequenceTakeModelId, SEQUENCE_TAKE_MAX_SHOTS, SEQUENCE_TAKE_MIN_SHOTS, SEQUENCE_TAKE_MODELS,
} from '../../../../server/lib/musicVideo/musicVideoSequenceTake.js';
import { musicVideoSequenceTake } from '../../services/apiMusicVideo.js';
import { formatUsd } from '../../utils/formatters.js';
import SentPromptPanel from '../media/SentPromptPanel';
import toast from '../ui/Toast';

const FIELD = 'min-w-0 rounded border border-port-border bg-port-bg px-2 py-1 text-base sm:text-xs min-h-[44px] pointer-fine:sm:min-h-0';

/**
 * Render a run of consecutive shots as one hosted take (#16128). The director
 * picks the first shot and how many follow, previews the exact prompt,
 * references and price (the server's dry run, the same code the render sends),
 * then sends it. The finished clip lands as a candidate take on every covered
 * shot with its own in-point; nothing is selected until the director picks it.
 */
export default function SequenceTakePanel({ project, shotName, disabled = false }) {
  const ids = useId();
  const ordered = [...(project?.scenes || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const [firstId, setFirstId] = useState(ordered[0]?.sceneId || '');
  const [count, setCount] = useState(SEQUENCE_TAKE_MIN_SHOTS);
  const [modelId, setModelId] = useState(() => defaultSequenceTakeModelId(project) || '');
  const [override, setOverride] = useState('');
  const [plan, setPlan] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const [open, setOpen] = useState(false);
  // A preview answers the inputs it was asked for; a later edit makes it stale.
  const generation = useRef(0);

  // A deleted first shot falls back to the board's first shot.
  const start = Math.max(0, ordered.findIndex((scene) => scene.sceneId === firstId));
  const first = ordered[start]?.sceneId || '';
  const maxCount = Math.max(0, Math.min(SEQUENCE_TAKE_MAX_SHOTS, ordered.length - start));
  const shots = ordered.slice(start, start + Math.min(count, maxCount));
  const sceneIds = shots.map((scene) => scene.sceneId);
  const counts = Array.from({ length: Math.max(0, maxCount - SEQUENCE_TAKE_MIN_SHOTS + 1) }, (_, i) => SEQUENCE_TAKE_MIN_SHOTS + i);
  const body = { sceneIds, ...(modelId ? { modelId } : {}), ...(override.trim() ? { prompt: override } : {}) };

  const edit = (apply) => (event) => {
    generation.current += 1;
    setPlan(null);
    setError('');
    apply(event.target.value);
  };

  const send = async (dryRun) => {
    const asked = generation.current;
    setBusy(dryRun ? 'preview' : 'render');
    setError('');
    const result = await musicVideoSequenceTake(project.id, { ...body, dryRun }, { silent: true })
      .catch((err) => { if (asked === generation.current) setError(err?.message || 'Could not plan the take'); return null; });
    setBusy(null);
    if (!result || asked !== generation.current) return;
    if (dryRun) { setPlan(result); return; }
    setPlan(null);
    toast.success(`Queued one ${result.seconds}s take for ${result.sceneIds.length} shots`);
  };

  if (ordered.length < SEQUENCE_TAKE_MIN_SHOTS || !SEQUENCE_TAKE_MODELS.length) return null;
  const framesMissing = shots.filter((scene) => !scene.referenceImageId);

  return (
    <section className="min-w-0 rounded border border-port-border p-2 text-xs" data-testid="sequence-take-panel">
      <button type="button" aria-expanded={open} aria-controls={`${ids}-body`} onClick={() => setOpen((v) => !v)}
        className="flex min-h-[44px] items-center gap-1 font-medium pointer-fine:sm:min-h-0">
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} Render shots as one take
      </button>
      {open && <div id={`${ids}-body`} className="mt-2 min-w-0 space-y-2">
        <p className="text-port-text-muted">
          One hosted reference-to-video take across {SEQUENCE_TAKE_MIN_SHOTS} to {SEQUENCE_TAKE_MAX_SHOTS} consecutive shots, written as numbered shots with hard cuts.
          It is filed on each shot with its own in-point; pick it on a shot to use it there, and nudge that shot&apos;s Offset to move its window.
        </p>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,12rem),18rem))] gap-2">
          <label htmlFor={`${ids}-first`} className="flex min-w-0 flex-col gap-1">From shot
            <select id={`${ids}-first`} value={first} disabled={disabled} onChange={edit((v) => { setFirstId(v); setCount(SEQUENCE_TAKE_MIN_SHOTS); })} className={FIELD}>
              {ordered.slice(0, ordered.length - 1).map((scene) => <option key={scene.sceneId} value={scene.sceneId}>{shotName(scene)}</option>)}
            </select>
          </label>
          <label htmlFor={`${ids}-count`} className="flex min-w-0 flex-col gap-1">Shots
            <select id={`${ids}-count`} value={Math.min(count, maxCount)} disabled={disabled} onChange={edit((v) => setCount(Number(v)))} className={FIELD}>
              {counts.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label htmlFor={`${ids}-model`} className="flex min-w-0 flex-col gap-1">Model
            <select id={`${ids}-model`} value={modelId} disabled={disabled} onChange={edit(setModelId)} className={FIELD}>
              {SEQUENCE_TAKE_MODELS.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
            </select>
          </label>
        </div>
        <p className="break-words text-port-text-muted">Covers: {shots.map(shotName).join(' → ') || 'no shots'}</p>
        <label htmlFor={`${ids}-prompt`} className="flex min-w-0 flex-col gap-1">Prompt (optional; replaces the composed prompt and is sent as written)
          <textarea id={`${ids}-prompt`} rows={3} value={override} disabled={disabled} onChange={edit(setOverride)} className={`${FIELD} w-full`}
            placeholder="Leave empty to send the composed prompt below" />
        </label>
        {framesMissing.length > 0 && (
          <p className="text-port-warning">{framesMissing.map(shotName).join(', ')} {framesMissing.length === 1 ? 'has' : 'have'} no start frame yet. Render or pick one on the shot first.</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={BUTTON} disabled={disabled || busy != null || sceneIds.length < SEQUENCE_TAKE_MIN_SHOTS} onClick={() => send(true)}>
            {busy === 'preview' ? 'Pricing…' : 'Preview prompt and price'}
          </button>
          {plan && (
            <button type="button" className={`${BUTTON} border-port-accent text-port-accent`} disabled={disabled || busy != null} onClick={() => send(false)}>
              <Film size={14} aria-hidden="true" /> {busy === 'render' ? 'Queueing…' : `Render as one take (${formatUsd(plan.estimatedCostUsd)})`}
            </button>
          )}
        </div>
        {error && <p role="alert" className="text-port-error">{error}</p>}
        {plan && (
          <div className="min-w-0 space-y-1 rounded border border-port-border p-2" data-testid="sequence-take-plan">
            <p className="text-port-text-muted">
              {plan.modelLabel}: one {plan.seconds}s take{plan.resolution ? ` at ${plan.resolution}` : ''} for {plan.sceneIds.length} shots ({plan.runSec}s of shots), est. {formatUsd(plan.estimatedCostUsd)}.
              {' '}{plan.references.length} of {plan.maxReferences} reference images
              {plan.omittedReferences > 0 ? `; ${plan.omittedReferences} more ${plan.omittedReferences === 1 ? 'reference was' : 'references were'} left out at the model's limit` : ''}.
            </p>
            <p className="whitespace-pre-wrap break-words">{plan.prompt}</p>
            <SentPromptPanel prompt={plan.promptOverride ? plan.prompt : ''} sentPrompt={plan.prompt} additions={plan.promptAdditions} />
          </div>
        )}
      </div>}
    </section>
  );
}
