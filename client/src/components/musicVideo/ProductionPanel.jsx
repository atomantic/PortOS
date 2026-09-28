import { useState } from 'react';
import { Clapperboard, Play, Pause, X } from 'lucide-react';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import ToggleChip from '../ui/ToggleChip.jsx';
import { DEFAULT_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOLS } from '../../lib/musicVideoAutomation.js';
import { formatUsd } from '../../utils/formatters.js';

const POOL_TOOLS = MUSIC_VIDEO_AUTOMATION_TOOLS.filter((t) => t.group === 'image' || t.group === 'video');
const POOL_TOOL_IDS = new Set(POOL_TOOLS.map((t) => t.id));

const STATUS_LABELS = {
  running: 'Running', stopped: 'Paused', 'limit-reached': 'Stopped at a limit', blocked: 'Blocked',
  'needs-replan': 'Setup changed', completed: 'Finished', 'needs-human': 'Needs you', failed: 'Failed', canceled: 'Cancelled',
};
const STATUS_TONES = {
  running: 'text-port-accent', stopped: 'text-port-warning', 'limit-reached': 'text-port-warning', blocked: 'text-port-warning',
  'needs-replan': 'text-port-warning', completed: 'text-port-success', 'needs-human': 'text-port-warning',
  failed: 'text-port-error', canceled: 'text-port-text-muted',
};
const STEP_TONES = { completed: 'text-port-success', failed: 'text-port-error', canceled: 'text-port-text-muted', refused: 'text-port-text-muted' };
const RESUMABLE = new Set(['running', 'stopped', 'limit-reached', 'blocked', 'needs-replan']);
const inputCls = 'w-24 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs';
const SHOWN_STEPS = 8;

const toolLabel = new Map(POOL_TOOLS.map((t) => [t.id, t.label]));
const routeLabel = (route) => `${toolLabel.get(`${route.kind}:${route.mode}`) || `${route.kind} ${route.mode}`}${route.model ? ` · ${route.model}` : ''}`;

/** The run worth showing: the live one, else the most recent. */
export const currentProductionRun = (project) => {
  const runs = Array.isArray(project?.productionRuns) ? project.productionRuns : [];
  return runs.find((r) => RESUMABLE.has(r.status)) || runs[runs.length - 1] || null;
};

const initialPool = (project) => {
  const fromBrief = (project?.automation?.tools || []).filter((id) => POOL_TOOL_IDS.has(id));
  return fromBrief.length ? fromBrief : DEFAULT_AUTOMATION_TOOLS.filter((id) => POOL_TOOL_IDS.has(id));
};

function StepRow({ step }) {
  return (
    <li className="flex flex-wrap gap-x-2 min-w-0">
      <span className="font-mono">{step.kind}</span>
      <span className="text-port-text-muted">{routeLabel(step.route)}</span>
      <span className={STEP_TONES[step.status] || 'text-port-accent'}>{step.status}</span>
      {step.rationale && <span className="text-port-text-muted min-w-0 break-words">{step.rationale}</span>}
      {step.error && <span role="status" className="text-port-error min-w-0 break-words">{step.error}</span>}
    </li>
  );
}

function RunView({ run, production }) {
  const live = RESUMABLE.has(run.status);
  const steps = run.steps || [];
  const failures = steps.filter((s) => s.error);
  const cap = run.limits.spendCapUsd;
  const needsReplan = run.status === 'needs-replan';
  const hint = run.interrupted
    ? 'The server restarted — nothing is running. Resume to continue.'
    : run.stopReason;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`font-medium ${STATUS_TONES[run.status] || ''}`}>{run.interrupted ? 'Interrupted' : STATUS_LABELS[run.status] || run.status}</span>
        <span className="text-port-text-muted">
          {run.usage.generations}/{run.limits.maxGenerations} generations · {formatUsd(run.usage.spentUsd)}{cap != null ? ` of ${formatUsd(cap)}` : ' spent (no cap)'}
        </span>
      </div>
      {run.directive && <p className="text-port-text-muted break-words">Directive: {run.directive}</p>}
      <p className="text-port-text-muted">Allowed: {(run.pool || []).map(routeLabel).join(', ')}</p>
      {hint && <p className="text-port-warning break-words">{hint}</p>}
      {run.error && <p role="status" className="text-port-error break-words">{run.error}</p>}
      {failures.length > 0 && <p className="text-port-error">{failures.length} step{failures.length === 1 ? '' : 's'} failed — see the list below.</p>}
      {steps.length > 0 && (
        <ul className="space-y-0.5" aria-label="Production steps">
          {steps.slice(-SHOWN_STEPS).reverse().map((step) => <StepRow key={step.key} step={step} />)}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        {run.status === 'running' && !run.interrupted && (
          <button type="button" disabled={production.busy} onClick={() => production.stop(run.id)}
            className="flex items-center gap-1 border border-port-border rounded px-3 py-2 min-h-[44px] sm:min-h-0 sm:px-2 sm:py-1 disabled:opacity-50">
            <Pause size={12} /> Stop
          </button>
        )}
        {live && (run.status !== 'running' || run.interrupted) && (
          <button type="button" disabled={production.busy}
            onClick={() => production.resume(run.id, needsReplan ? { acceptBasis: true } : {})}
            className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-2 min-h-[44px] sm:min-h-0 sm:px-2 sm:py-1 disabled:opacity-50">
            <Play size={12} /> {needsReplan ? 'Resume with the new setup' : 'Resume'}
          </button>
        )}
        {live && (
          <button type="button" disabled={production.busy} onClick={() => production.cancel(run.id)}
            className="flex items-center gap-1 border border-port-border rounded px-3 py-2 min-h-[44px] sm:min-h-0 sm:px-2 sm:py-1 disabled:opacity-50">
            <X size={12} /> Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function StartForm({ project, production }) {
  const [pool, setPool] = useState(() => initialPool(project));
  const [directive, setDirective] = useState('');
  const [maxGenerations, setMaxGenerations] = useState(12);
  const [maxReviewAttempts, setMaxReviewAttempts] = useState(3);
  const [spendCap, setSpendCap] = useState('');
  const {
    providers, selectedProviderId, selectedModel, availableModels, setSelectedProviderId, setSelectedModel,
  } = useProviderModels({ allowDefault: true, silent: true });
  const idFor = (s) => `mv-production-${project?.id}-${s}`;
  const picked = new Set(pool);
  const capValue = spendCap === '' ? null : Number(spendCap);
  const hasImage = pool.some((id) => id.startsWith('image:'));
  const hasVideo = pool.some((id) => id.startsWith('video:'));
  const valid = hasImage && hasVideo
    && Number.isInteger(maxGenerations) && maxGenerations >= 1 && maxGenerations <= 500
    && Number.isInteger(maxReviewAttempts) && maxReviewAttempts >= 1 && maxReviewAttempts <= 10
    && (capValue == null || (Number.isFinite(capValue) && capValue >= 0));

  const toggle = (id) => setPool((cur) => (cur.includes(id) ? cur.filter((t) => t !== id) : [...cur, id]));
  const start = () => production.start({
    ...(directive.trim() ? { directive: directive.trim() } : {}),
    pool: POOL_TOOLS.filter((t) => picked.has(t.id)).map((t) => {
      const [kind, mode] = t.id.split(':');
      return { kind, mode };
    }),
    limits: { maxGenerations, maxReviewAttempts, ...(capValue != null ? { spendCapUsd: capValue } : {}) },
    ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
  });

  return (
    <div className="space-y-2">
      <p className="text-port-text-muted">
        Plans the board, generates the missing frames and clips, renders and reviews the draft, and revises failed sections — on the server, so you can close this tab.
        Only the routes you allow are ever used, and it never exceeds the limits below. Metered routes have no known price, so a dollar cap refuses them.
      </p>
      <fieldset className="min-w-0" aria-labelledby={idFor('pool-label')}>
        <span id={idFor('pool-label')} className="block text-[11px] text-port-text-muted mb-1">Allowed image and video routes</span>
        <div className="flex flex-wrap gap-1.5">
          {POOL_TOOLS.map((tool) => (
            <ToggleChip
              key={tool.id}
              id={idFor(`tool-${tool.id}`)}
              label={tool.metered ? `${tool.label} $` : tool.label}
              hint={tool.metered ? 'Spends money or remote quota' : undefined}
              checked={picked.has(tool.id)}
              onToggle={() => toggle(tool.id)}
            />
          ))}
        </div>
        {!(hasImage && hasVideo) && <p className="text-port-warning mt-1">Allow at least one image and one video route.</p>}
      </fieldset>
      <div>
        <label htmlFor={idFor('directive')} className="block text-[10px] text-port-text-muted">Production directive</label>
        <textarea id={idFor('directive')} rows={2} maxLength={4000} value={directive} onChange={(e) => setDirective(e.target.value)}
          placeholder="What to make and what to avoid — steers the plan when the board is empty."
          className="w-full min-w-0 bg-port-bg border border-port-border rounded px-2 py-1.5 text-xs" />
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor={idFor('generations')} className="block text-[10px] text-port-text-muted">Max generations</label>
          <input id={idFor('generations')} type="number" min={1} max={500} step={1} value={maxGenerations} disabled={production.busy}
            onChange={(e) => setMaxGenerations(Number(e.target.value))} className={inputCls} />
        </div>
        <div>
          <label htmlFor={idFor('attempts')} className="block text-[10px] text-port-text-muted">Max reviews</label>
          <input id={idFor('attempts')} type="number" min={1} max={10} step={1} value={maxReviewAttempts} disabled={production.busy}
            onChange={(e) => setMaxReviewAttempts(Number(e.target.value))} className={inputCls} />
        </div>
        <div>
          <label htmlFor={idFor('cap')} className="block text-[10px] text-port-text-muted">Spend cap (USD)</label>
          <input id={idFor('cap')} type="number" min={0} step={1} inputMode="decimal" value={spendCap} disabled={production.busy}
            placeholder="No cap" onChange={(e) => setSpendCap(e.target.value)} className={inputCls} />
        </div>
        {providers.length > 0 && (
          <ProviderModelSelector
            providers={providers}
            selectedProviderId={selectedProviderId}
            selectedModel={selectedModel}
            availableModels={availableModels}
            onProviderChange={setSelectedProviderId}
            onModelChange={setSelectedModel}
            label="Reviewer (vision)"
            disabled={production.busy}
            modelDisabled={availableModels.length === 0}
            compact
          />
        )}
        <button type="button" disabled={production.busy || !valid} onClick={start}
          className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-2 min-h-[44px] sm:min-h-0 sm:px-2 sm:py-1 disabled:opacity-50">
          <Play size={12} /> {production.busy ? 'Starting…' : 'Start production'}
        </button>
      </div>
    </div>
  );
}

/**
 * Server-owned production run (#9066): nothing runs until the director starts
 * it with an allowed provider/model pool and explicit limits. Progress arrives
 * over the `music-video:production` socket event via `useMusicVideoProduction`.
 */
export default function ProductionPanel({ project, production }) {
  const run = currentProductionRun(project);
  const active = run && RESUMABLE.has(run.status);
  return (
    <div className="rounded border border-port-border p-2 space-y-2 text-xs" aria-label="Production run">
      <span className="font-medium flex items-center gap-1"><Clapperboard size={12} /> Autonomous production (opt-in)</span>
      {run && <RunView run={run} production={production} />}
      {!active && <StartForm key={run?.id || 'new'} project={project} production={production} />}
    </div>
  );
}
