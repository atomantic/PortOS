import { useEffect, useMemo, useState } from 'react';
import { Check, Circle, Loader2, LockKeyhole, MoveRight } from 'lucide-react';
import { fableLoomProductionWorkflow } from '../../lib/fableLoomReadiness';
import { getLoomEditorialAutopilotStatus } from '../../services/api';

const ACTIVE_STATUSES = new Set(['running', 'canceling']);

const ACTION_LABELS = {
  settings: 'Open story settings',
  'series-plan': 'Open series plan',
  outline: 'Open episode outline',
  'episode-setup': 'Open episode setup',
  'story-review': 'Review structure',
  continuity: 'Open continuity review',
  render: 'Open render queue',
  play: 'Play the episode',
};

const tone = (status) => {
  if (status === 'complete') return 'border-port-success/30 bg-port-success/5 text-port-success';
  if (status === 'current') return 'border-port-accent/50 bg-port-accent/10 text-port-text';
  return 'border-port-border/70 bg-port-bg/30 text-port-text-muted';
};

export default function LoomWorkflowPanel({
  loom,
  episode,
  structural,
  continuityReview,
  onAction,
}) {
  const [editorialRun, setEditorialRun] = useState(null);

  useEffect(() => {
    let canceled = false;
    let timer;
    const load = () => getLoomEditorialAutopilotStatus(loom.id, { silent: true })
      .then(({ run }) => {
        if (canceled) return;
        setEditorialRun(run || null);
        if (ACTIVE_STATUSES.has(run?.status)) timer = setTimeout(load, 2000);
      })
      .catch(() => {
        if (!canceled) setEditorialRun(null);
      });
    load();
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [loom.id]);

  const workflow = useMemo(() => fableLoomProductionWorkflow(loom, episode, {
    structural,
    editorialRun,
    continuityReview,
  }), [continuityReview, editorialRun, episode, loom, structural]);
  const current = workflow.stages[workflow.currentIndex];
  const progress = Math.round((workflow.completedCount / workflow.totalSteps) * 100);

  return (
    <section className="space-y-4" aria-label="Production workflow">
      <header>
        <div className="flex items-baseline justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold">Production workflow</h3>
            <p className="mt-0.5 text-xs text-port-text-muted">
              Manual authoring and AI use the same ordered gates.
            </p>
          </div>
          <span className="shrink-0 text-xs font-medium text-port-accent">
            Step {workflow.currentStep} of {workflow.totalSteps}
          </span>
        </div>
        <div
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-port-border"
          role="progressbar"
          aria-label="Production progress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow={progress}
        >
          <div className="h-full rounded-full bg-port-accent transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      </header>

      <ol className="space-y-1.5">
        {workflow.stages.map((stage) => (
          <li
            key={stage.id}
            className={`rounded border px-2.5 py-2 ${tone(stage.status)}`}
            aria-current={stage.status === 'current' ? 'step' : undefined}
          >
            <div className="flex items-center gap-2">
              <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
                stage.status === 'current' ? 'bg-port-accent text-white' : 'bg-port-card'
              }`}>
                {stage.status === 'complete' ? <Check size={12} /> : stage.number}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{stage.label}</span>
              {stage.status === 'current' && ACTIVE_STATUSES.has(editorialRun?.status) && stage.id === 'editorial'
                ? <Loader2 size={12} className="shrink-0 animate-spin text-port-accent" />
                : stage.status === 'blocked'
                  ? <LockKeyhole size={11} className="shrink-0 opacity-50" />
                  : <Circle size={8} className="shrink-0 fill-current" />}
            </div>
            {stage.status === 'current' ? (
              <p className="ml-7 mt-1 text-[11px] leading-relaxed text-port-text-muted">{stage.detail}</p>
            ) : null}
          </li>
        ))}
      </ol>

      {current ? (
        <button
          type="button"
          onClick={() => onAction?.(current.action)}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded bg-port-accent px-3 py-2 text-sm font-medium text-white hover:bg-port-accent/90"
        >
          {ACTION_LABELS[current.action] || 'Open current step'}
          <MoveRight size={14} />
        </button>
      ) : null}
    </section>
  );
}
