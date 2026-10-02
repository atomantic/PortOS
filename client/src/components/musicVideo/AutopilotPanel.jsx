import { useState } from 'react';
import { Bot, Clapperboard, Pause, Play, X } from 'lucide-react';
import AutomationBriefFields from './AutomationBriefFields.jsx';
import Pill from '../ui/Pill.jsx';
import { supportsToolFreeOneShot, toolFreeOneShotSelectionPolicy } from '../../utils/providerSelection.js';
import useProviderModels from '../../hooks/useProviderModels.js';
import ProviderModelSelector from '../ProviderModelSelector.jsx';
import ToggleChip from '../ui/ToggleChip.jsx';
import MediumPlanSummary from './MediumPlanSummary.jsx';
import { codeFirstProductionAssets } from '../../../../server/lib/musicVideoMediumPlan.js';
import {
  DEFAULT_AUTOMATION_TOOLS, MUSIC_VIDEO_AUTOMATION_TOOLS, automationDraftFrom, automationFromDraft, llmRouteLabel,
} from '../../lib/musicVideoAutomation.js';
import { RESUMABLE_RUN_STATUSES, currentProductionRun } from '../../lib/musicVideoStages.js';
import { formatCount, formatUsd } from '../../utils/formatters.js';

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
const inputCls = 'w-24 bg-port-bg border border-port-border rounded px-1.5 py-1 text-xs min-h-[44px] sm:min-h-0';
const SHOWN_STEPS = 8;

const toolLabel = new Map(POOL_TOOLS.map((t) => [t.id, t.label]));
const briefToolLabel = new Map(MUSIC_VIDEO_AUTOMATION_TOOLS.map((t) => [t.id, t.label]));
const actionClass = 'text-sm text-port-accent min-h-[44px] sm:min-h-0 px-1';
const routeLabel = (route) => `${toolLabel.get(`${route.kind}:${route.mode}`) || `${route.kind} ${route.mode}`}${route.model ? ` · ${route.model}` : ''}`;

const ROUTE_LABELS = [['plan', 'Shot planning'], ['castAndSets', 'Cast & Sets direction']];

const initialPool = (project) => {
  const fromBrief = (project?.automation?.tools || []).filter((id) => POOL_TOOL_IDS.has(id));
  const assets = codeFirstProductionAssets(project);
  const choices = fromBrief.length ? fromBrief : DEFAULT_AUTOMATION_TOOLS.filter((id) => POOL_TOOL_IDS.has(id));
  return assets ? choices.filter((id) => assets.requiredRoutes[id.split(':')[0]]) : choices;
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

function RunView({ run, production, codeFirst, project }) {
  const [budget, setBudget] = useState(null);
  const live = RESUMABLE_RUN_STATUSES.has(run.status);
  const steps = run.steps || [];
  const failures = steps.filter((s) => s.error);
  const cap = run.limits.spendCapUsd;
  const needsReplan = run.status === 'needs-replan';
  const resumeValid = !budget || (Number.isInteger(budget.maxGenerations) && budget.maxGenerations >= run.limits.maxGenerations && budget.maxGenerations <= 500
    && Number.isInteger(budget.maxReviewAttempts) && budget.maxReviewAttempts >= run.limits.maxReviewAttempts && budget.maxReviewAttempts <= 10
    && (budget.spendCapUsd == null || (Number.isFinite(budget.spendCapUsd) && budget.spendCapUsd >= cap && budget.spendCapUsd <= 100000)));
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
      {run.authoring && <p className="text-port-text-muted">Authoring: {run.authoring.providerId} · {run.authoring.model}{run.authoring.effort ? ` · ${run.authoring.effort}` : ''} · {run.authoring.costUsd == null ? 'unknown dollar cost (generation count still bounded)' : 'no per-call dollar charge; local compute or quota may apply'}</p>}
      {steps.some((step) => step.kind === 'plate') && <p className="text-port-text-muted">Plate preflight calls consume the generation limit. {steps.some((step) => step.kind === 'plate' && step.costUsd == null) ? 'Their dollar cost is unpriced; use a free vision API reviewer for dollar-capped runs.' : 'Their reserved dollar cost is included in the run total.'}</p>}
      {run.authoring && <p className="text-port-text-muted">{['author', 'frame', 'clip'].map((kind) => {
        const used = steps.filter((step) => step.kind === kind && step.status !== 'refused');
        const cost = used.reduce((total, step) => total + (step.costUsd || 0), 0);
        return `${kind === 'author' ? 'Code authoring' : kind === 'frame' ? 'Images' : 'Video'}: ${formatUsd(cost)} known${used.some((step) => step.costUsd == null) ? ' + unpriced calls' : ''}`;
      }).join(' · ')}. Reviewer calls use the separate review limit and may also cost money.</p>}
      <p className="text-port-text-muted">Allowed: {(run.pool || []).map(routeLabel).join(', ')}</p>
      {run.accounting && <div aria-label="Production budget" className="text-port-text-muted space-y-1">
        <p>Planned remaining: {formatCount(run.accounting.plannedGenerations)} asset jobs · Reserved: {formatUsd(run.accounting.reservedUsd)} · Spent: {formatUsd(run.accounting.spentUsd)}{run.accounting.unpriced ? ' + unpriced calls' : ''}</p>
        <p>Reviews: {formatCount(run.accounting.reviews)} / {formatCount(run.limits.maxReviewAttempts)} shared by pilots and final review.</p>
        <p>Expected next spend: {run.nextSpend ? run.nextSpend.costUsd == null ? 'unpriced — refused under a dollar cap' : formatUsd(run.nextSpend.costUsd) : 'quoted before the next submission'}</p>
      </div>}
      {run.pilot && <div aria-label="Production pilot evidence" className="border border-port-border rounded p-2 space-y-1">
        <p className="font-medium">Representative asset pilots</p>
        <p className="text-port-text-muted">Accepted takes are reused. Every current pilot must pass continuous review before bulk production. Document composition is reviewed after asset preparation.</p>
        {(run.pilot.scenes || []).map((pilot) => {
          const excerpt = project.excerpts?.find((e) => e.id === pilot.excerptId);
          return <div key={pilot.sceneId} className="space-y-0.5">
            <p>{pilot.operation}: {pilot.sceneId} · {pilot.status || 'pending'}
              {excerpt?.filename && <> · <a href={`/data/videos/${excerpt.filename}`} target="_blank" rel="noreferrer" className="text-port-accent underline">Watch pilot</a></>}
            </p>
            {pilot.evidence && <p className="text-port-text-muted">Continuous analysis: {pilot.evidence.continuous ? 'verified' : 'unverified'} · Sampled frames: {formatCount(pilot.evidence.continuousFrames)} · Temporal alignment: {pilot.evidence.temporal?.status || 'unverified'}</p>}
            {pilot.repair && <p className="text-port-warning">Repair: {pilot.repair.category} · {pilot.repair.reason} Replacement generation spend for this repair stage: {formatUsd(pilot.repair.expectedGenerationSpendUsd)}.</p>}
          </div>;
        })}
      </div>}
      {hint && <p className="text-port-warning break-words">{hint}</p>}
      {steps.some((step) => step.retryBlocked) && <p className="text-port-warning">Terminal refusal recorded: unchanged inputs will not be submitted again on Resume. Repair the shot or cancel and choose another supported route. No new spend is reserved while blocked.</p>}
      {run.error && <p role="status" className="text-port-error break-words">{run.error}</p>}
      {failures.length > 0 && <p className="text-port-error">{failures.length} step{failures.length === 1 ? '' : 's'} failed — see the list below.</p>}
      {steps.length > 0 && (
        <ul className="space-y-0.5" aria-label="Production steps">
          {steps.slice(-SHOWN_STEPS).reverse().map((step) => <StepRow key={step.key} step={step} />)}
        </ul>
      )}
      {live && run.status === 'limit-reached' && <fieldset className="flex flex-wrap gap-2" aria-label="Raise production limits">
        <label htmlFor={`production-generations-${run.id}`}>Max generations
          <input id={`production-generations-${run.id}`} type="number" min={run.limits.maxGenerations} max={500} value={budget?.maxGenerations ?? run.limits.maxGenerations}
            onChange={(e) => setBudget((b) => ({ ...run.limits, ...b, maxGenerations: Number(e.target.value) }))} className={inputCls} />
        </label>
        <label htmlFor={`production-reviews-${run.id}`}>Max reviews
          <input id={`production-reviews-${run.id}`} type="number" min={run.limits.maxReviewAttempts} max={10} value={budget?.maxReviewAttempts ?? run.limits.maxReviewAttempts}
            onChange={(e) => setBudget((b) => ({ ...run.limits, ...b, maxReviewAttempts: Number(e.target.value) }))} className={inputCls} />
        </label>
        {cap != null && <label htmlFor={`production-cap-${run.id}`}>Spend cap (USD)
          <input id={`production-cap-${run.id}`} type="number" min={cap} max={100000} step={0.01} value={budget?.spendCapUsd ?? cap}
            onChange={(e) => setBudget((b) => ({ ...run.limits, ...b, spendCapUsd: Number(e.target.value) }))} className={inputCls} />
        </label>}
      </fieldset>}
      <div className="flex flex-wrap gap-2">
        {run.status === 'running' && !run.interrupted && (
          <button type="button" disabled={production.busy} onClick={() => production.stop(run.id)}
            className="flex items-center gap-1 border border-port-border rounded px-3 py-2 min-h-[44px] sm:min-h-0 sm:px-2 sm:py-1 disabled:opacity-50">
            <Pause size={12} /> Stop
          </button>
        )}
        {live && (!codeFirst || run.authoring) && (run.status !== 'running' || run.interrupted) && (
          <button type="button" disabled={production.busy || !resumeValid}
            onClick={() => production.resume(run.id, { ...(needsReplan ? { acceptBasis: true } : {}), ...(budget ? { limits: budget } : {}) })}
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
  const assets = codeFirstProductionAssets(project);
  const author = useProviderModels({ allowDefault: false, silent: true, withEffort: true, filter: Boolean });
  const [authorEffort, setAuthorEffort] = useState('');
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
  const routesValid = assets ? (!assets.requiredRoutes.image || hasImage) && (!assets.requiredRoutes.video || hasVideo) : hasImage && hasVideo;
  const valid = routesValid && (!assets || (project.scenes?.length > 0 && assets.conflicts.length === 0 && supportsToolFreeOneShot(author.selectedProvider || author.providers.find((entry) => entry.id === author.selectedProviderId)) && author.selectedProviderId && author.selectedModel))
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
    ...(assets ? { authoring: { providerId: author.selectedProviderId, model: author.selectedModel, ...(authorEffort ? { effort: authorEffort } : {}) } } : {}),
    limits: { maxGenerations, maxReviewAttempts, ...(capValue != null ? { spendCapUsd: capValue } : {}) },
    ...(selectedProviderId ? { providerId: selectedProviderId } : {}),
    ...(selectedModel ? { model: selectedModel } : {}),
  });

  return (
    <div className="space-y-2">
      <p className="text-port-text-muted">
        {assets ? 'Reviews representative selected assets before bulk preparation, authors the document, reviews motion and audio in a continuous excerpt, revises failed code sections, then renders the chosen document.' : 'Plans the board, reviews representative pilots before bulk generation, renders and reviews the draft, and revises failed sections — on the server, so you can close this tab.'}
        Only the routes you allow are ever used, and it never exceeds the limits below. fal.ai video is charged each take's estimated list price (its model, length and resolution); other metered routes have no known price, so a dollar cap refuses them.
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
        {!routesValid && <p className="text-port-warning mt-1">{assets ? 'Allow routes only for the still/video jobs required by the approved plan.' : 'Allow at least one image and one video route.'}</p>}
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
        {assets && <ProviderModelSelector
          providers={author.providers}
          selectedProviderId={author.selectedProviderId}
          selectedModel={author.selectedModel}
          availableModels={author.availableModels}
          onProviderChange={(id) => { author.setSelectedProviderId(id); setAuthorEffort(''); }}
          onModelChange={author.setSelectedModel}
          effort={authorEffort}
          onEffortChange={setAuthorEffort}
          selectionPolicy={toolFreeOneShotSelectionPolicy} label="Code authoring"
          disabled={production.busy}
          modelDisabled={author.availableModels.length === 0}
          compact
        />}
        {assets && <p className="text-port-text-muted">Choose an API provider or a server-verified tool-free CLI; TUI sessions cannot author. Authoring calls consume the generation limit. Unknown authoring prices require no dollar cap; a free/local authoring provider can use a cap. Reviews have a separate call limit.</p>}
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
        <button type="button" id="mv-production-start" disabled={production.busy || !valid} onClick={start}
          className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-2 min-h-[44px] sm:min-h-0 sm:px-2 sm:py-1 disabled:opacity-50">
          <Play size={12} /> {production.busy ? 'Starting…' : 'Start production'}
        </button>
      </div>
    </div>
  );
}

/** The brief: tools, guidance and budget, with the one-click kickoff. */
function BriefSection({ project, onSave, onKickoff, kickoffBusy, kickoffStep, kickoffBlockedReason }) {
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const automation = project.automation || null;

  const save = () => {
    setSaving(true);
    const payload = automationFromDraft(draft);
    // Back to Auto clears the saved pin explicitly: an absent key keeps it server-side.
    if (!payload.llm && automation?.llm) payload.llm = null;
    onSave(payload)
      .then(() => setDraft(null))
      // A failed save keeps the brief open for another try.
      .catch(() => {})
      .finally(() => setSaving(false));
  };

  let header = null;
  let body;
  if (draft) {
    body = (
      <fieldset disabled={saving} className="space-y-3 min-w-0">
        <AutomationBriefFields idPrefix={`mv-auto-${project.id}`} draft={draft} onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))} />
        <div className="flex flex-wrap gap-3">
          <button type="button" onClick={save} className="bg-port-accent text-white rounded px-3 py-2 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50">
            {saving ? 'Saving…' : 'Save brief'}
          </button>
          <button type="button" onClick={() => setDraft(null)} className="text-sm min-h-[44px] sm:min-h-0">Cancel</button>
        </div>
      </fieldset>
    );
  } else if (automation) {
    header = (
      <>
        <span className="text-xs text-port-text-muted">
          {automation.tools.length} tool{automation.tools.length === 1 ? '' : 's'}
          {' · '}
          {automation.budgetUsd != null ? `${formatUsd(automation.budgetUsd)} cap` : 'no budget cap'}
          {' · '}
          {automation.checkins?.castAndSets === 'auto' ? 'check-ins auto-approved' : 'stops for check-ins'}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setDraft(automationDraftFrom(automation))} className={actionClass}>Edit brief</button>
          <button
            type="button"
            onClick={onKickoff}
            disabled={kickoffBusy || !!kickoffBlockedReason}
            title={kickoffBlockedReason || 'Analyze the song, import its lyrics, separate and align the vocal, build the Cast & Sets check-in, then plan every shot against the brief'}
            className="flex items-center gap-1 bg-port-accent text-white rounded px-3 py-1.5 text-sm min-h-[44px] sm:min-h-0 disabled:opacity-50"
          >
            <Play size={14} /> {kickoffBusy ? 'Working…' : 'Analyze & plan'}
          </button>
        </div>
      </>
    );
    body = (
      <>
        {automation.tools.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {automation.tools.map((id) => <Pill key={id} size="xs" bordered={false}>{briefToolLabel.get(id) || id}</Pill>)}
          </div>
        )}
        <p className="text-xs text-port-text-muted break-words line-clamp-3">
          {automation.guidance || 'No guidance yet — the agent plans from the song, universe and board alone.'}
        </p>
        <p className="text-xs text-port-text-muted break-words">
          Direction LLM: {automation.llm?.providerId ? llmRouteLabel(automation.llm) : 'Auto — a TUI provider when one is eligible'}
        </p>
        {ROUTE_LABELS.map(([stage, label]) => automation.routes?.[stage] && (
          <p key={stage} className="text-xs text-port-text-muted break-words">
            {label} ran on {llmRouteLabel(automation.routes[stage])}
            {automation.routes[stage].requestedProviderId ? ` — replaced the unavailable ${automation.routes[stage].requestedProviderId}` : ''}
          </p>
        ))}
        {kickoffStep && <p className="text-xs text-port-accent" role="status">{kickoffStep}</p>}
        {kickoffBlockedReason && <p className="text-xs text-port-warning">{kickoffBlockedReason}</p>}
      </>
    );
  } else {
    header = (
      <button type="button" onClick={() => setDraft(automationDraftFrom(null))} className={`ml-auto ${actionClass}`}>Set up autopilot</button>
    );
    body = <p className="text-xs text-port-text-muted">Hand this video to the agent: pick the tools it may use, give it guidance and a budget.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Bot size={16} className="text-port-accent shrink-0" aria-hidden="true" />
        <h3 className="text-sm font-medium">Autopilot</h3>
        {header}
      </div>
      {body}
    </div>
  );
}

/**
 * Server-owned production run (#9066): nothing runs until the director starts
 * it with an allowed provider/model pool and explicit limits. Progress arrives
 * over the `music-video:production` socket event via `useMusicVideoProduction`.
 */
function ProductionSection({ project, production }) {
  const run = currentProductionRun(project);
  const active = run && RESUMABLE_RUN_STATUSES.has(run.status);
  const codeFirst = project.productionPolicy?.strategy === 'code-first';
  const assets = codeFirst ? codeFirstProductionAssets(project) : null;
  const count = (action) => formatCount(assets.steps.filter((step) => step.action === action).length);
  return (
    <div className="rounded border border-port-border p-2 space-y-2 text-xs" aria-label="Production run">
      <span className="font-medium flex items-center gap-1"><Clapperboard size={12} /> Autonomous production (opt-in)</span>
      {run && <RunView key={run.id} run={run} production={production} codeFirst={codeFirst} project={project} />}
      {codeFirst && <>
        <MediumPlanSummary project={project} />
        <div className="rounded border border-port-border p-2 space-y-1" aria-label="Code-first asset preflight">
          <p className="font-medium">Selected asset preparation</p>
          <p className="text-port-text-muted">
            Procedural: {count('code')} · Reused stills: {count('reuse-image')} · Reused takes: {count('reuse-video')} · Still jobs: {count('generate-image')} · Video jobs: {count('generate-video')}
          </p>
          <p className="text-port-text-muted">Routes needed for selected assets: {assets.requiredRoutes.image ? 'image' : 'no image'} · {assets.requiredRoutes.video ? 'video' : 'no video'}</p>
          {assets.conflicts.length > 0 && <ul className="list-disc pl-4 text-port-warning">
            {assets.conflicts.map((conflict, index) => <li key={`${index}-${conflict}`}>{conflict}</li>)}
          </ul>}
          <p className="text-port-text-muted">Code authoring, still jobs, and video jobs use separate providers and costs. Starting production uses only this approved asset plan.</p>
        </div>
      </>}
      {!active && <StartForm key={run?.id || 'new'} project={project} production={production} />}
    </div>
  );
}

/**
 * Autopilot: one card holding the project's automation brief (tools, guidance,
 * budget, kickoff) and its server-side production run (allowed routes,
 * generation and spend caps, the run log). Edits PATCH through `onSave`, which
 * owns the error toast; `production` is the `useMusicVideoProduction` slot.
 * `kickoffStep` names the kickoff step running now.
 */
export default function AutopilotPanel({
  project, production, onSave, onKickoff, kickoffBusy, kickoffStep = null, kickoffBlockedReason,
}) {
  return (
    <section className="bg-port-card border border-port-border rounded-lg p-3 space-y-3 min-w-0" aria-label="Autopilot">
      <BriefSection
        project={project}
        onSave={onSave}
        onKickoff={onKickoff}
        kickoffBusy={kickoffBusy}
        kickoffStep={kickoffStep}
        kickoffBlockedReason={kickoffBlockedReason}
      />
      <ProductionSection project={project} production={production} />
    </section>
  );
}
