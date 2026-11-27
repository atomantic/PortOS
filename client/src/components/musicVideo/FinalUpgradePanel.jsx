import { sceneButtonClass as BUTTON } from './controlClasses.js';
import { useEffect, useId, useState } from 'react';
import { Activity, ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import { finalTierCounts, sceneClipIsFinal, sceneFinalApproved, selectedVideoTake } from '../../../../server/lib/musicVideo/musicVideoFinalApproval.js';
import { upgradeMusicVideoShots } from '../../services/apiMusicVideo.js';
import { formatUsd } from '../../utils/formatters.js';
import toast from '../ui/Toast';
import RealesrganInstallButton from '../media/RealesrganInstallButton';

const UPGRADE_METHODS = Object.freeze([
  { id: 'upscale', label: 'Upscale the draft', help: 'Keeps the exact approved take and runs a 2x upscaler over it; the upscaled take is selected. No provider spend.' },
  { id: 'rerender', label: 'Re-render at final', help: "Renders a new final-resolution take from the same prompt and frames. Models have no seed to repeat, so it lands beside the draft unselected: compare them on the shot and pick it." },
]);

// Upscalers an `upscale` upgrade can run (#19985); Real-ESRGAN is an opt-in local install.
const UPSCALERS = Object.freeze([
  { id: 'lanczos', label: 'Lanczos (fast, pixel-faithful)' },
  { id: 'realesrgan', label: 'Real-ESRGAN (local GPU, adds detail)' },
]);

const SKIP_LABELS = Object.freeze({
  'upscaler-not-ready': 'the upscaler is not installed',
  'no-clip': 'no clip selected',
  'already-final': 'already final',
  'not-approved': 'not approved',
  'no-final-tier': "its model has no final tier, so it cannot be re-rendered at one",
});

/** The upgrade's price as the button shows it: `$X`, no spend, or unknown (a lane PortOS cannot price). */
function upgradePriceLabel(plan) {
  if (!plan) return null;
  if (plan.totalCostUsd == null) return 'price unknown';
  return plan.totalCostUsd === 0 ? 'no provider cost' : formatUsd(plan.totalCostUsd);
}

function resultLabel(result) {
  if (!result.ok) return result.error || SKIP_LABELS[result.status] || 'not upgraded';
  if (result.queued) return 'Real-ESRGAN upscale queued; the final take is selected when it lands';
  return result.method === 'upscale' ? 'upscaled; the final take is selected' : 'final render queued; it lands beside the draft';
}

/**
 * Upgrade approved draft shots to the final resolution (#16136). Shots render cheap drafts first;
 * the director ticks the ones that are right (here in bulk, or on the shot card), picks a method,
 * sees the server's dry-run plan and price, then runs it. Each shot reports its own outcome.
 */
export default function FinalUpgradePanel({ project, shotName, disabled = false, onApprove, onOpenShot = null }) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const [method, setMethod] = useState('upscale');
  const [upscaleMethod, setUpscaleMethod] = useState('lanczos');
  // Bumped after a Real-ESRGAN install so the dry run asks again.
  const [installs, setInstalls] = useState(0);
  const [plan, setPlan] = useState(null);
  const [planError, setPlanError] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [approving, setApproving] = useState(false);
  const scenes = project?.scenes || [];
  const counts = finalTierCounts(scenes);
  const drafts = scenes.filter((scene) => selectedVideoTake(scene) && !sceneClipIsFinal(scene));
  const approved = drafts.filter(sceneFinalApproved);
  // The dry run answers these approvals under this method; any change to them asks again.
  const planKey = JSON.stringify([method, method === 'upscale' ? upscaleMethod : null, installs, approved.map((scene) => [scene.sceneId, scene.finalApproval?.takeId, scene.finalApproval?.revision]), project?.videoSettings]);
  const upgradeBody = method === 'upscale' ? { method, upscaleMethod } : { method };

  useEffect(() => {
    setPlan(null);
    setPlanError('');
    if (!open || !approved.length) return undefined;
    let active = true;
    upgradeMusicVideoShots(project.id, { ...upgradeBody, dryRun: true }, { silent: true })
      .then((next) => { if (active) setPlan(next); })
      .catch((err) => { if (active) setPlanError(err?.message || 'Could not price the upgrade'); });
    return () => { active = false; };
    // planKey covers the approvals, method and settings the plan reads.
  }, [open, project?.id, planKey]);

  if (!counts.draft && !counts.final) return null;

  const approve = (sceneIds, next) => {
    if (!sceneIds.length || approving) return;
    setApproving(true);
    Promise.resolve(onApprove?.(sceneIds, next)).finally(() => setApproving(false));
  };
  const ready = plan?.shots?.filter((shot) => shot.status === 'ready') || [];
  // Until the dry run answers, the button counts the ticks; after, the shots it will actually upgrade.
  const upgradeCount = plan ? ready.length : approved.length;
  const run = async () => {
    setRunning(true);
    setResults(null);
    const outcome = await upgradeMusicVideoShots(project.id, upgradeBody, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not upgrade the shots'); return null; });
    setRunning(false);
    if (!outcome) return;
    setResults(outcome.results || []);
    const done = (outcome.results || []).filter((result) => result.ok).length;
    const verb = method !== 'upscale' ? 'Queued final renders for' : upscaleMethod === 'realesrgan' ? 'Queued Real-ESRGAN upscales for' : 'Upscaled';
    toast.success(`${verb} ${done} of ${outcome.results?.length || 0} shots`);
  };
  const name = (sceneId) => {
    const scene = scenes.find((entry) => entry.sceneId === sceneId);
    return scene ? shotName(scene) : 'A deleted shot';
  };
  const price = upgradePriceLabel(plan);

  return (
    <section className="min-w-0 rounded border border-port-border p-2 text-xs" data-testid="final-upgrade-panel">
      <button type="button" aria-expanded={open} aria-controls={`${ids}-body`} onClick={() => setOpen((v) => !v)}
        className="flex min-h-[44px] flex-wrap items-center gap-1 text-left font-medium pointer-fine:sm:min-h-0">
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />} Upgrade drafts to final
        <span className="font-normal text-port-text-muted" data-testid="final-tier-counts">
          · {counts.draft} draft · {counts.approved} approved · {counts.final} final{counts.missing ? ` · ${counts.missing} no clip` : ''}
        </span>
      </button>
      {open && <div id={`${ids}-body`} className="mt-2 min-w-0 space-y-2">
        <p className="text-port-text-muted">
          Render every shot as a cheap draft, fix it there, then tick the shots that are right and pay for the final resolution on those alone.
          Changing a ticked shot&apos;s prompt, frames or selected take clears its tick.
        </p>
        {drafts.length > 0 && (
          <fieldset className="min-w-0 space-y-1" disabled={disabled || approving}>
            <legend className="font-medium">Approve for final</legend>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={BUTTON} onClick={() => approve(drafts.filter((scene) => !sceneFinalApproved(scene)).map((scene) => scene.sceneId), true)}
                disabled={approved.length === drafts.length}>Approve all drafts ({drafts.length})</button>
              <button type="button" className={BUTTON} onClick={() => approve(approved.map((scene) => scene.sceneId), false)}
                disabled={!approved.length}>Clear approvals</button>
            </div>
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-1">
              {drafts.map((scene) => (
                <li key={scene.sceneId} className="min-w-0">
                  <label htmlFor={`${ids}-${scene.sceneId}`} className="flex min-h-[44px] min-w-0 items-center gap-2 pointer-fine:sm:min-h-0">
                    <input id={`${ids}-${scene.sceneId}`} type="checkbox" checked={sceneFinalApproved(scene)}
                      onChange={(event) => approve([scene.sceneId], event.target.checked)} />
                    <span className="truncate">{shotName(scene)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <fieldset className="min-w-0 space-y-1" disabled={disabled || running}>
          <legend className="font-medium">Method</legend>
          {UPGRADE_METHODS.map((option) => (
            <label key={option.id} htmlFor={`${ids}-method-${option.id}`} className="flex min-h-[44px] items-start gap-2 pointer-fine:sm:min-h-0">
              <input id={`${ids}-method-${option.id}`} type="radio" name={`${ids}-method`} value={option.id} checked={method === option.id}
                onChange={() => { setMethod(option.id); setResults(null); }} className="mt-0.5" />
              <span><span className="font-medium">{option.label}</span> <span className="text-port-text-muted">{option.help}</span></span>
            </label>
          ))}
          {method === 'upscale' && (
            <div className="flex min-w-0 flex-wrap items-center gap-2 pl-6">
              <label htmlFor={`${ids}-upscaler`} className="text-port-text-muted">Upscaler</label>
              <select id={`${ids}-upscaler`} value={upscaleMethod} onChange={(event) => { setUpscaleMethod(event.target.value); setResults(null); }}
                className="min-h-[44px] rounded border border-port-border bg-port-bg p-1 pointer-fine:sm:min-h-0">
                {UPSCALERS.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </div>
          )}
        </fieldset>
        {method === 'upscale' && upscaleMethod === 'realesrgan' && plan?.upscalerReason && (
          <p role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-port-warning">
            <span>{plan.upscalerReason}</span>
            {plan.upscalerSupported !== false && (
              <RealesrganInstallButton installTarget={plan.upscalerInstallTarget} onInstalled={() => setInstalls((n) => n + 1)} />
            )}
          </p>
        )}
        {!approved.length && <p className="text-port-text-muted">Tick at least one draft shot to upgrade it.</p>}
        {planError && <p role="alert" className="text-port-error">{planError}</p>}
        {plan && (
          <ul className="space-y-0.5" data-testid="final-upgrade-plan">
            {plan.shots.map((shot) => (
              <li key={shot.sceneId} className={shot.status === 'ready' ? '' : 'text-port-text-muted'}>
                {name(shot.sceneId)}: {shot.status === 'ready'
                  ? `${shot.method === 'upscale' ? `upscale 2x${shot.upscaleMethod === 'realesrgan' ? ' with Real-ESRGAN' : ''}` : `re-render at ${shot.resolution}`}${shot.costUsd == null ? ' · price unknown' : shot.costUsd ? ` · ${formatUsd(shot.costUsd)}` : ''}`
                  : SKIP_LABELS[shot.status] || shot.status}
              </li>
            ))}
          </ul>
        )}
        {approved.length > 0 && (
          <button type="button" className={`${BUTTON} border-port-accent text-port-accent`} onClick={run}
            disabled={disabled || running || !plan || !ready.length} data-testid="final-upgrade-run">
            {running ? <Activity size={14} className="animate-spin" aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}
            {running ? `Upgrading ${upgradeCount} shots…` : `Upgrade approved (${upgradeCount}) · ${price || 'pricing…'}`}
          </button>
        )}
        {results && (
          <ul className="space-y-0.5" aria-live="polite" data-testid="final-upgrade-results">
            {results.map((result) => (
              <li key={result.sceneId} className={result.ok ? 'text-port-success' : 'text-port-warning'}>
                {onOpenShot ? (
                  <button type="button" className="min-h-[44px] underline pointer-fine:sm:min-h-0" onClick={() => onOpenShot(result.sceneId)}>{name(result.sceneId)}</button>
                ) : name(result.sceneId)}: {resultLabel(result)}
              </li>
            ))}
          </ul>
        )}
      </div>}
    </section>
  );
}
