import { useEffect, useMemo, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { SkipForward, RotateCw, CheckCircle2, RefreshCw, AlertTriangle, Sparkles, ExternalLink } from 'lucide-react';
import toast from '../ui/Toast';
import Drawer from '../Drawer';
import DirectiveComposer from './DirectiveComposer.jsx';
import {
  getCreativeToolCatalog,
  setCreativeDirectorDirective,
  replanCreativeDirectorProject,
  updateCreativeDirectorPlanStep,
} from '../../services/apiCreativeDirector.js';
import { listUniverses } from '../../services/apiUniverseBuilder.js';
import { listPipelineSeries } from '../../services/apiPipeline.js';
import {
  annotatePlanSteps,
  planCostSummary,
  planStatusSummary,
  stepResultLink,
  PLAN_STEP_STATUS_META,
  COST_CLASS_META,
  TONE_BADGE,
} from '../../lib/creativeDirectorPlan.js';
import { formatDateTime, formatDurationMs } from '../../utils/formatters';

const Badge = ({ tone, children, title }) => (
  <span title={title} className={`text-xs px-2 py-0.5 rounded ${TONE_BADGE[tone] || TONE_BADGE.muted}`}>{children}</span>
);

const EMPTY_DIRECTIVE = { goal: '', deliverables: [], constraints: { universeId: null, seriesId: null, budgetCap: null } };

export default function PlanTab({ project, onProjectUpdate }) {
  const [catalog, setCatalog] = useState({ tools: [], mode: 'execute', budget: { withinBudget: true } });
  const [busyStep, setBusyStep] = useState(null); // `${stepId}:${action}` while a triage call is in flight
  const [replanning, setReplanning] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const composerOpen = searchParams.get('directive') === 'edit';

  // Composer state hoisted above the Drawer body (Drawer state-hoisting rule).
  const [draft, setDraft] = useState(EMPTY_DIRECTIVE);
  const [savingDirective, setSavingDirective] = useState(false);
  const [universes, setUniverses] = useState([]);
  const [series, setSeries] = useState([]);

  // Tool catalog drives cost-class badges + the dry-run banner + approval gating.
  // Fetched once (silent — the board degrades gracefully to no cost badges on
  // failure rather than toasting on a passive tab open).
  useEffect(() => {
    let alive = true;
    getCreativeToolCatalog({ silent: true })
      .then((data) => { if (alive && data) setCatalog(data); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const toolMap = useMemo(() => {
    const m = new Map();
    for (const t of (catalog.tools || [])) m.set(t.id, t);
    return m;
  }, [catalog.tools]);

  const withinBudget = catalog.budget?.withinBudget !== false;
  const steps = useMemo(
    () => annotatePlanSteps(project.plan?.steps, project.runs, toolMap, { withinBudget }),
    [project.plan, project.runs, toolMap, withinBudget],
  );
  const costCounts = useMemo(() => planCostSummary(steps), [steps]);
  const statusCounts = useMemo(() => planStatusSummary(steps), [steps]);

  const openComposer = useCallback(() => {
    setDraft(project.directive
      ? { ...EMPTY_DIRECTIVE, ...project.directive, constraints: { ...EMPTY_DIRECTIVE.constraints, ...(project.directive.constraints || {}) } }
      : EMPTY_DIRECTIVE);
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.set('directive', 'edit'); return n; }, { replace: true });
    // Lazy-load the pickers on open.
    if (!universes.length) listUniverses({ silent: true }).then((u) => setUniverses(Array.isArray(u) ? u : (u?.items || []))).catch(() => {});
    if (!series.length) listPipelineSeries({ silent: true }).then((s) => setSeries(Array.isArray(s) ? s : (s?.items || []))).catch(() => {});
  }, [project.directive, setSearchParams, universes.length, series.length]);

  const closeComposer = useCallback(() => {
    setSearchParams((prev) => { const n = new URLSearchParams(prev); n.delete('directive'); return n; }, { replace: true });
  }, [setSearchParams]);

  const submitDirective = async () => {
    if (!draft.goal.trim()) { toast.error('Goal is required'); return; }
    setSavingDirective(true);
    const updated = await setCreativeDirectorDirective(project.id, {
      goal: draft.goal.trim(),
      deliverables: draft.deliverables || [],
      constraints: draft.constraints || {},
    }, { silent: true }).catch((e) => { toast.error(e.message || 'Failed to save directive'); return null; });
    setSavingDirective(false);
    if (!updated) return;
    onProjectUpdate?.(updated);
    toast.success(project.directive ? 'Directive updated — re-planning' : 'Directive set — planning');
    closeComposer();
  };

  const runStepAction = async (stepId, action) => {
    const key = `${stepId}:${action}`;
    setBusyStep(key);
    const updated = await updateCreativeDirectorPlanStep(project.id, stepId, action, { silent: true })
      .catch((e) => { toast.error(e.message || `Failed to ${action} step`); return null; });
    setBusyStep(null);
    if (!updated) return;
    onProjectUpdate?.(updated);
    toast.success(action === 'skip' ? 'Step skipped' : 'Step re-queued');
  };

  const handleReplan = async () => {
    setReplanning(true);
    const updated = await replanCreativeDirectorProject(project.id, { silent: true })
      .catch((e) => { toast.error(e.message || 'Failed to re-plan'); return null; });
    setReplanning(false);
    if (!updated) return;
    onProjectUpdate?.(updated);
    toast.success('Re-planning — the planner will propose a fresh step list');
  };

  const directiveDrawer = (
    <Drawer
      open={composerOpen}
      onClose={closeComposer}
      title={project.directive ? 'Edit directive' : 'Add a directive'}
      size="lg"
      closeOnEsc={false}
      closeOnBackdrop={false}
    >
      <p className="text-xs text-port-text-muted mb-3">
        A directive turns this project into a studio production: the planner agent derives a plan of creative-tool
        steps (series, covers, teaser, …) and the generalized advance loop executes them one at a time through the
        governed dispatch gate.
      </p>
      <DirectiveComposer
        directive={draft}
        onChange={setDraft}
        universes={universes}
        series={series}
        idPrefix="cd-directive"
        disabled={savingDirective}
      />
      <div className="flex gap-2 justify-end mt-5 pt-4 border-t border-port-border">
        <button onClick={closeComposer} className="px-3 py-1.5 rounded text-sm bg-port-bg border border-port-border">Cancel</button>
        <button
          onClick={submitDirective}
          disabled={savingDirective || !draft.goal.trim()}
          className="px-3 py-1.5 rounded text-sm bg-port-accent text-white disabled:opacity-50"
        >
          {savingDirective ? 'Saving…' : (project.directive ? 'Save & re-plan' : 'Set directive & plan')}
        </button>
      </div>
    </Drawer>
  );

  // ---- Legacy video project (no directive) — offer to convert. -------------
  if (!project.directive) {
    return (
      <div className="max-w-3xl">
        <div className="bg-port-card border border-port-border rounded p-5 text-sm text-port-text-muted">
          <div className="flex items-center gap-2 text-port-text mb-2">
            <Sparkles className="w-4 h-4 text-port-accent" />
            <span className="font-medium">No production directive</span>
          </div>
          <p className="mb-3">
            This is a legacy video project — it runs the built-in treatment / scene flow. Add a directive to
            promote it into a studio production the Creative Director plans and executes across the whole creative
            suite.
          </p>
          <button onClick={openComposer} className="px-3 py-1.5 rounded text-sm bg-port-accent text-white">
            Add a directive
          </button>
        </div>
        {directiveDrawer}
      </div>
    );
  }

  const blocked = project.status === 'paused' && (steps.some((s) => s.status === 'blocked') || project.failureReason);
  const planning = project.status === 'planning';
  const hasPlan = steps.length > 0;

  return (
    <div className="max-w-4xl space-y-4">
      {/* Directive summary */}
      <div className="bg-port-card border border-port-border rounded p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-wide text-port-text-muted mb-1">Directive</div>
            <div className="text-sm text-port-text whitespace-pre-wrap break-words">{project.directive.goal}</div>
            {Array.isArray(project.directive.deliverables) && project.directive.deliverables.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {project.directive.deliverables.map((d) => (
                  <span key={d} className="text-xs px-2 py-0.5 rounded-full bg-port-bg border border-port-border text-port-text-muted">{d}</span>
                ))}
              </div>
            )}
            {project.directive.constraints?.budgetCap != null && (
              <div className="text-xs text-port-text-muted mt-2">Budget cap: {project.directive.constraints.budgetCap} actions/day</div>
            )}
          </div>
          <div className="flex gap-1 shrink-0">
            <button onClick={openComposer} className="px-2 py-1 rounded text-xs bg-port-bg border border-port-border">Edit</button>
            <button onClick={handleReplan} disabled={replanning} className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-bg border border-port-border disabled:opacity-50">
              <RefreshCw className="w-3 h-3" /> {replanning ? 'Re-planning…' : 'Re-plan'}
            </button>
          </div>
        </div>
      </div>

      {/* Dry-run banner */}
      {catalog.mode === 'dry-run' && (
        <div className="bg-port-accent/10 border border-port-accent/40 rounded p-3 text-xs text-port-accent">
          Creative autonomy is in <span className="font-semibold">dry-run</span> mode — plan steps are previewed
          (cost classes shown below) but not executed. Switch to <span className="font-mono">execute</span> in
          Settings to run the plan.
        </div>
      )}
      {catalog.mode === 'off' && (
        <div className="bg-port-warning/10 border border-port-warning/40 rounded p-3 text-xs text-port-warning">
          Creative autonomy is <span className="font-semibold">off</span> — the plan will not execute until you
          enable it in Settings. Steps below are shown for review only.
        </div>
      )}

      {/* Blocked-step triage banner */}
      {blocked && (
        <div className="bg-port-error/10 border border-port-error/40 rounded p-4">
          <div className="flex items-center gap-2 text-port-error font-medium mb-1">
            <AlertTriangle className="w-4 h-4" /> Plan paused
          </div>
          {project.failureReason && (
            <p className="text-sm text-port-text-muted mb-3 break-words">{project.failureReason}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {steps.filter((s) => s.status === 'blocked' || s.status === 'failed').map((s) => (
              <button
                key={s.stepId}
                onClick={() => runStepAction(s.stepId, 'retry')}
                disabled={busyStep === `${s.stepId}:retry`}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent/30 text-port-accent disabled:opacity-50"
              >
                <RotateCw className="w-3 h-3" /> Resume &ldquo;{s.stepId}&rdquo;
              </button>
            ))}
            <button onClick={handleReplan} disabled={replanning} className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-bg border border-port-border disabled:opacity-50">
              <RefreshCw className="w-3 h-3" /> Request re-plan
            </button>
          </div>
        </div>
      )}

      {/* Plan progress summary */}
      {hasPlan && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-port-text-muted">{steps.length} step{steps.length === 1 ? '' : 's'}:</span>
          {Object.entries(statusCounts).filter(([, n]) => n > 0).map(([status, n]) => (
            <Badge key={status} tone={PLAN_STEP_STATUS_META[status]?.tone}>{n} {PLAN_STEP_STATUS_META[status]?.label || status}</Badge>
          ))}
          <span className="text-port-text-muted ml-2">cost:</span>
          {Object.entries(costCounts).filter(([, n]) => n > 0).map(([cls, n]) => (
            <Badge key={cls} tone={COST_CLASS_META[cls]?.tone}>{n} {COST_CLASS_META[cls]?.label || cls}</Badge>
          ))}
        </div>
      )}

      {/* Planning / empty state */}
      {!hasPlan && (
        <div className="bg-port-card border border-port-border rounded p-5 text-sm text-port-text-muted">
          {planning
            ? 'The planner is deriving a step list from the directive… this tab updates as the plan lands.'
            : 'No plan yet. Start the project (or re-plan) to have the planner derive a step list from the directive.'}
        </div>
      )}

      {/* Step board */}
      {hasPlan && (
        <div className="space-y-2">
          {steps.map((s) => {
            const statusMeta = PLAN_STEP_STATUS_META[s.status] || PLAN_STEP_STATUS_META.pending;
            const link = stepResultLink(s);
            const durationMs = s.startedAt && s.completedAt ? new Date(s.completedAt) - new Date(s.startedAt) : null;
            const canSkip = s.status === 'pending' || s.status === 'blocked' || s.status === 'failed';
            const canRetry = s.status === 'blocked' || s.status === 'failed';
            const needsApproval = s.requiresApproval && (s.status === 'pending' || s.status === 'blocked');
            return (
              <div key={s.stepId} className="bg-port-card border border-port-border rounded p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">{s.stepId}</span>
                      <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                      {s.costClass && <Badge tone={COST_CLASS_META[s.costClass]?.tone} title="Cost class">{COST_CLASS_META[s.costClass]?.label}</Badge>}
                      {s.longRunning && <Badge tone="muted" title="Long-running (completes via events)">long-running</Badge>}
                      {s.destructive && <Badge tone="error" title="Destructive — requires approval">destructive</Badge>}
                      {s.unknownTool && <Badge tone="warning" title="Tool not in the current registry">unknown tool</Badge>}
                    </div>
                    <div className="text-xs text-port-text-muted font-mono mt-1 truncate">{s.toolName}</div>
                    {Array.isArray(s.dependsOn) && s.dependsOn.length > 0 && (
                      <div className="text-xs text-port-text-muted mt-1">depends on: {s.dependsOn.join(', ')}</div>
                    )}
                    <div className="text-xs text-port-text-muted mt-1">
                      {s.startedAt && formatDateTime(s.startedAt)}
                      {s.completedAt && ` → ${formatDateTime(s.completedAt)}`}
                      {durationMs != null && ` (${formatDurationMs(durationMs)})`}
                      {s.retryCount ? ` · retries: ${s.retryCount}` : ''}
                    </div>
                    {s.result?.reason && (
                      <div className="text-xs text-port-warning mt-1 break-words">{s.result.reason}</div>
                    )}
                    {s.result?.error && (
                      <div className="text-xs text-port-error mt-1 break-words">{s.result.error}</div>
                    )}
                    {link && (
                      <Link to={link.to} className="inline-flex items-center gap-1 text-xs text-port-accent mt-1">
                        <ExternalLink className="w-3 h-3" /> {link.label}
                      </Link>
                    )}
                    {needsApproval && (
                      <div className="text-xs text-port-warning mt-1">
                        {s.destructive ? 'Destructive step — needs approval before it runs.' : 'Over the action budget — raise the cap, then approve.'}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    {needsApproval && (
                      <button
                        onClick={() => runStepAction(s.stepId, 'retry')}
                        disabled={busyStep === `${s.stepId}:retry`}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-accent/30 text-port-accent disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-3 h-3" /> Approve
                      </button>
                    )}
                    {canRetry && !needsApproval && (
                      <button
                        onClick={() => runStepAction(s.stepId, 'retry')}
                        disabled={busyStep === `${s.stepId}:retry`}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-bg border border-port-border disabled:opacity-50"
                      >
                        <RotateCw className="w-3 h-3" /> Retry
                      </button>
                    )}
                    {canSkip && (
                      <button
                        onClick={() => runStepAction(s.stepId, 'skip')}
                        disabled={busyStep === `${s.stepId}:skip`}
                        className="flex items-center gap-1 px-2 py-1 rounded text-xs bg-port-bg border border-port-border disabled:opacity-50"
                      >
                        <SkipForward className="w-3 h-3" /> Skip
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {directiveDrawer}
    </div>
  );
}
