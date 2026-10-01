import { useState } from 'react';
import { Bot, Play, Pause, X } from 'lucide-react';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import { formatTimecode } from '../../utils/formatters.js';

const STATUS_LABELS = {
  running: 'Running', stopped: 'Paused', 'limit-reached': 'Stopped at a limit', passed: 'Passed',
  'needs-human': 'Needs you', failed: 'Failed', canceled: 'Cancelled',
};
const STATUS_TONES = {
  running: 'text-port-accent', stopped: 'text-port-warning', 'limit-reached': 'text-port-warning', passed: 'text-port-success',
  'needs-human': 'text-port-warning', failed: 'text-port-error', canceled: 'text-port-text-muted',
};
const CHECK_TONES = { pass: 'bg-port-success/20 text-port-success', fail: 'bg-port-error/20 text-port-error', unverified: 'bg-port-border text-port-text-muted' };
const CHECK_LABELS = { composition: 'Composition', continuity: 'Continuity', motion: 'Motion', audioSync: 'Stream-duration parity', lipSync: 'Temporal lip-sync' };
const ACTION_LABELS = {
  wait: (a) => (a.on === 'generation' ? 'Waiting for the revised sections to generate…' : 'Rendering the draft…'),
  reviewing: () => 'Reviewing the draft (frames + continuous excerpt)…',
  generate: (a) => `Generating ${a.sections?.length || 0} revised section${a.sections?.length === 1 ? '' : 's'}…`,
};
const ACTIVE = new Set(['running', 'stopped', 'limit-reached']);
const inputCls = 'w-20 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';

/** The latest run worth showing: the live one, else the most recent. */
export const currentAutoReview = (project) => {
  const runs = Array.isArray(project?.autoReviews) ? project.autoReviews : [];
  return runs.find((r) => ACTIVE.has(r.status)) || runs[runs.length - 1] || null;
};

function LimitInputs({ idFor, attempts, generations, onAttempts, onGenerations, disabled }) {
  return (
    <>
      <div>
        <label htmlFor={idFor('attempts')} className="block text-[10px] text-port-text-muted">Max reviews</label>
        <input id={idFor('attempts')} type="number" min={1} max={10} step={1} value={attempts} disabled={disabled}
          onChange={(e) => onAttempts(Number(e.target.value))} className={inputCls} />
      </div>
      <div>
        <label htmlFor={idFor('generations')} className="block text-[10px] text-port-text-muted">Max paid generations</label>
        <input id={idFor('generations')} type="number" min={0} max={100} step={1} value={generations} disabled={disabled}
          onChange={(e) => onGenerations(Number(e.target.value))} className={inputCls} />
      </div>
    </>
  );
}

function AttemptRow({ attempt }) {
  const { review } = attempt;
  return (
    <li className="rounded border border-port-border p-1.5 space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">Attempt {attempt.n}</span>
        {review ? <span className="uppercase text-[10px] text-port-text-muted">{review.verdict}</span> : <span className="text-port-text-muted">not reviewed yet</span>}
        {review && Object.entries(CHECK_LABELS).map(([key, label]) => (
          <span key={key} className={`px-1.5 py-0.5 rounded text-[10px] ${CHECK_TONES[review.checks?.[key]] || CHECK_TONES.unverified}`}>
            {label}: {review.checks?.[key] || 'unverified'}
          </span>
        ))}
      </div>
      {review?.evidence && (
        <p className="text-[10px] text-port-text-muted">
          Evidence: {review.evidence.boundaryFrames ? 'cut/cue sheet + ' : ''}{review.evidence.continuousFrames || 0} continuous frames
          {review.evidence.continuous ? ' + continuous-excerpt analysis' : ` — continuous analysis unavailable (${review.evidence.continuousError || 'not run'})`}
        </p>
      )}
      {review?.evidence?.temporal && <p className="text-[10px] text-port-text-muted">
        Temporal evidence: {review.evidence.temporal.status}
        {review.evidence.temporal.analyzer && ` · ${review.evidence.temporal.analyzer.id} ${review.evidence.temporal.analyzer.version}`}
        {review.evidence.temporal.reason && ` — ${review.evidence.temporal.reason}`}
      </p>}
      {review?.summary && <p className="text-port-text-muted">{review.summary}</p>}
      {review?.findings?.length > 0 && (
        <ul className="space-y-0.5">
          {review.findings.map((f, i) => (
            <li key={`${f.atSec}-${i}`} className="flex flex-wrap gap-1.5">
              {/* Blocking findings are also flagged notes on that draft, where they seek the player. */}
              <span className="font-mono text-port-accent">{formatTimecode(f.atSec)}</span>
              <span className={f.severity === 'blocking' ? 'text-port-error' : 'text-port-text-muted'}>{f.note}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Opt-in automatic review/retries (#8988). Nothing runs until the director
 * starts a run over the draft window with their own limits: how many drafts
 * may be reviewed (each review is one call to the chosen vision model) and how
 * many PAID scene generations the run's revisions may spend. The review sees
 * the cut/cue contact sheet plus frames across the whole continuous excerpt,
 * and the excerpt file itself is analysed for frozen footage and audio/picture
 * parity — a frame-only look can never pass motion or audio sync.
 */
export default function AutoReviewPanel({ project, startSec, endSec, rangeValid, rendering, autoReview }) {
  const run = currentAutoReview(project);
  const [attempts, setAttempts] = useState(3);
  const [generations, setGenerations] = useState(4);
  const [raiseAttempts, setRaiseAttempts] = useState(null);
  const [raiseGenerations, setRaiseGenerations] = useState(null);
  const {
    providers, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });
  const idFor = (s) => `mv-auto-review-${project?.id}-${s}`;
  const active = run && ACTIVE.has(run.status);
  const limitsValid = Number.isInteger(attempts) && attempts >= 1 && attempts <= 10
    && Number.isInteger(generations) && generations >= 0 && generations <= 100;
  const busy = autoReview.busy;
  const actionLabel = run?.status === 'running' && autoReview.action && ACTION_LABELS[autoReview.action.type]?.(autoReview.action);

  const resume = () => {
    const limits = {};
    if (raiseAttempts != null) limits.maxAttempts = raiseAttempts;
    if (raiseGenerations != null) limits.maxGenerations = raiseGenerations;
    autoReview.resume(run.id, Object.keys(limits).length ? limits : undefined).then(() => {
      setRaiseAttempts(null);
      setRaiseGenerations(null);
    });
  };

  return (
    <div className="rounded border border-port-border p-2 space-y-2 text-xs" aria-label="Automatic review">
      <span className="font-medium flex items-center gap-1"><Bot size={12} /> Auto-review (opt-in)</span>
      {!active && (
        <div className="space-y-2">
          <p className="text-port-text-muted">
            Renders the window above, has a vision model review it, and regenerates only the sections it flags — until the draft passes or a limit is hit.
            Regeneration is paid work; the run never exceeds the limits you set.
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <LimitInputs idFor={idFor} attempts={attempts} generations={generations} onAttempts={setAttempts} onGenerations={setGenerations} disabled={busy} />
            {providers.length > 0 && (
              <ProviderModelSelector
                providers={providers}
                selectedProviderId={selectedProviderId}
                selectedModel={selectedModel}
                availableModels={availableModels}
                onProviderChange={setSelectedProviderId}
                onModelChange={setSelectedModel}
                label="Reviewer (vision)"
                disabled={busy}
                modelDisabled={availableModels.length === 0}
                compact
                alwaysShowModel
                emptyProviderOption="Active provider (default)"
                emptyModelOption="Default model"
              />
            )}
            <button type="button" disabled={busy || rendering || !rangeValid || !limitsValid}
              onClick={() => autoReview.start(startSec, endSec, { maxAttempts: attempts, maxGenerations: generations }, { providerId: selectedProviderId, model: selectedModel })}
              className="flex items-center gap-1 bg-port-accent/20 text-port-accent disabled:opacity-50 rounded px-2 py-1.5 min-h-[44px] sm:min-h-0">
              <Play size={12} /> Start auto-review
            </button>
          </div>
        </div>
      )}
      {run?.documentRevisions && <p className="text-port-text-muted">Code-first review revises failed document sections through the production authoring budget. Selected assets and the generated-video allowance stay fixed; changing the medium requires your plan edit.</p>}
      {run && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className={STATUS_TONES[run.status]}>{STATUS_LABELS[run.status] || run.status}</span>
              <span className="text-port-text-muted"> · {formatTimecode(run.startSec)}–{formatTimecode(run.endSec)} · reviews {run.usage.reviews}/{run.limits.maxAttempts} · paid generations {run.usage.generations}/{run.limits.maxGenerations}</span>
            </span>
            {active && (
              <div className="flex items-center gap-2">
                {/* After a reload the board may have missed a hand-out: Continue re-derives the step. */}
                {run.status === 'running' && !autoReview.action && (
                  <button type="button" disabled={busy} onClick={() => autoReview.resume(run.id)} className="flex items-center gap-1 text-port-accent disabled:opacity-50 min-h-[44px] sm:min-h-0"><Play size={12} /> Continue</button>
                )}
                {run.status === 'running'
                  ? <button type="button" disabled={busy} onClick={() => autoReview.stop(run.id)} className="flex items-center gap-1 text-port-warning disabled:opacity-50 min-h-[44px] sm:min-h-0"><Pause size={12} /> Pause</button>
                  : <button type="button" disabled={busy} onClick={resume} className="flex items-center gap-1 text-port-accent disabled:opacity-50 min-h-[44px] sm:min-h-0"><Play size={12} /> Resume</button>}
                <button type="button" disabled={busy} onClick={() => autoReview.cancel(run.id)} className="flex items-center gap-1 text-port-error disabled:opacity-50 min-h-[44px] sm:min-h-0"><X size={12} /> Cancel run</button>
              </div>
            )}
          </div>
          {actionLabel && <p className="text-port-text-muted">{actionLabel}</p>}
          {run.stopReason && run.status !== 'running' && <p role="status" className={STATUS_TONES[run.status]}>{run.stopReason}</p>}
          {run.status === 'limit-reached' && (
            <div className="flex flex-wrap items-end gap-2">
              <LimitInputs idFor={(s) => idFor(`raise-${s}`)}
                attempts={raiseAttempts ?? run.limits.maxAttempts} generations={raiseGenerations ?? run.limits.maxGenerations}
                onAttempts={setRaiseAttempts} onGenerations={setRaiseGenerations} disabled={busy} />
              <span className="text-port-text-muted">Raise a limit, then Resume.</span>
            </div>
          )}
          <ul className="space-y-1">
            {run.attempts.map((attempt) => <AttemptRow key={attempt.n} attempt={attempt} />)}
          </ul>
        </div>
      )}
    </div>
  );
}
