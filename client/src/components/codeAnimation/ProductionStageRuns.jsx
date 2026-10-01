import { useState } from 'react';
import { useAsyncAction } from '../../hooks/useAsyncAction';
import {
  cancelCodeAnimationStageRun, preflightCodeAnimationProject, startCodeAnimationStageRun,
} from '../../services/apiCodeAnimation';
import { formatCount, formatRuntime, timeAgo } from '../../utils/formatters';

const buttonClass = 'rounded border border-port-border px-3 py-2 text-sm hover:border-port-accent disabled:opacity-50';
const STAGE_LABELS = { 'style-frame': 'Style frames', pilot: 'Pilot', review: 'Visual review', inspect: 'Inspection', repair: 'Repair', final: 'Final render' };
const RESUMABLE = new Set(['interrupted', 'canceled', 'exhausted', 'failed']);

export const isStageRun = run => run?.data?.kind === 'production-stages';

/** Verified and unverified dimensions are drawn differently on purpose: unverified is never a pass. */
function Verdict({ verdict, verified = [] }) {
  if (!verdict) return null;
  return <div className="space-y-1 text-xs">
    <p>Verdict: <strong>{verdict.status}</strong>{verdict.reason ? ` — ${verdict.reason}` : ''}</p>
    {verified.length > 0 && <p className="text-port-success">Verified: {verified.join(', ')}</p>}
    {(verdict.unverified || []).map(item => <p key={item.dimension} className="rounded border border-dashed border-port-warning px-2 py-1 text-port-warning">Unverified: {item.dimension} — {item.reason}</p>)}
  </div>;
}

function StageRun({ run, busy, onResume, onCancel }) {
  const { data } = run;
  const inspect = [...data.stages].reverse().find(stage => stage.key === 'inspect' && stage.status === 'completed');
  const frames = data.stages.filter(stage => stage.key === 'style-frame').flatMap(stage => stage.artifacts || []);
  const reviewer = [...data.stages].reverse().find(stage => stage.key === 'review' && stage.reviewer)?.reviewer;
  const running = run.status === 'running';
  return <li className="min-w-0 space-y-2 rounded border border-port-border p-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
      <span>Production run · <strong>{run.status}</strong>{data.stopReason ? ` (${data.stopReason})` : ''}</span>
      <span className="text-xs text-gray-400">{timeAgo(run.createdAt)} · {formatRuntime(data.spent?.elapsedMs || 0)} · {formatCount(data.spent?.iterations || 0)}/{formatCount(data.budgets?.iterations || 0)} repairs</span>
    </div>
    <ol className="space-y-1 text-xs" aria-label="Stages">
      {data.stages.map(stage => <li key={stage.stageRunId} className="flex flex-wrap justify-between gap-2">
        <span>{STAGE_LABELS[stage.key] || stage.key}{stage.reusedFrom ? ' (reused)' : ''}</span>
        <span className={stage.status === 'failed' || stage.status === 'exhausted' ? 'text-port-error' : 'text-gray-400'}>{stage.status}{stage.error ? ` · ${stage.error}` : ''}</span>
      </li>)}
    </ol>
    {reviewer && <p className="text-xs text-gray-400">Reviewed by {reviewer.providerId} · {reviewer.model || 'default model'}</p>}
    <Verdict verdict={data.verdict} verified={inspect?.verified} />
    {data.findings?.length > 0 && <ul className="space-y-1 text-xs" aria-label="Findings">
      {data.findings.map((finding, index) => <li key={index} className={finding.severity === 'error' ? 'text-port-error' : 'text-port-warning'}>
        [{finding.severity}] {finding.kind}: {finding.detail}{finding.atSeconds != null ? ` (at ${finding.atSeconds}s)` : ''} <span className="text-gray-400">· {timeAgo(finding.capturedAt)}</span>
      </li>)}
    </ul>}
    {frames.length > 0 && <div className="flex flex-wrap gap-2">
      {frames.map(frame => <a key={frame.relativePath} href={`/data/${frame.relativePath}`} target="_blank" rel="noreferrer" className="text-xs underline">Style frame at {frame.atSeconds}s</a>)}
    </div>}
    {data.output?.path && <a href={data.output.path} target="_blank" rel="noreferrer" className="block text-xs underline">Open final video</a>}
    {data.error && <p role="status" className="text-xs text-port-error">{data.error.message}</p>}
    <div className="flex flex-wrap gap-2">
      {running && <button type="button" className={buttonClass} disabled={busy} onClick={() => onCancel(run.id)}>Cancel run</button>}
      {RESUMABLE.has(run.status) && data.resumable && <button type="button" className={buttonClass} disabled={busy} onClick={() => onResume(run.id)}>Resume run</button>}
    </div>
  </li>;
}

/**
 * Starts, watches, cancels and resumes bounded production stage runs. The run
 * list is the project's history (kept live by the code-animation:changed event
 * in the parent); nothing here polls and no provider is called before Start.
 */
export default function ProductionStageRuns({ project, runs, disabled }) {
  const [confirming, setConfirming] = useState(false);
  const [capabilities, setCapabilities] = useState(null);
  const [visualReview, setVisualReview] = useState(false);
  const [act, busy] = useAsyncAction(async operation => operation());
  const live = runs.some(run => run.status === 'running');
  const settings = project.localSettings || {};
  const hasSource = Boolean(project.candidateRevisionId || project.acceptedRevisionId);

  const openConfirm = () => act(async () => {
    setCapabilities((await preflightCodeAnimationProject(project.id, { silent: true })).capabilities || null);
    setConfirming(true);
  });
  const start = input => act(async () => {
    await startCodeAnimationStageRun(project.id, input, { silent: true });
    setConfirming(false);
    setVisualReview(false);
  });
  const canReview = Boolean(capabilities?.imageInputAccepted);
  return <section className="space-y-3 rounded border border-port-border p-3" aria-label="Production stages">
    <h3 className="text-sm font-semibold">Production stages</h3>
    <p className="text-xs text-gray-400">Measures real style frames and a pilot, inspects the evidence, repairs measured errors through your saved authoring route, then renders the final video. Nothing runs until you start it.</p>
    {!confirming && <button type="button" className={buttonClass} disabled={disabled || busy || live || !hasSource} onClick={openConfirm}>Run production stages</button>}
    {!hasSource && <p className="text-xs text-gray-400">Import a source package first.</p>}
    {confirming && <div role="group" aria-label="Confirm production run" className="space-y-2 rounded border border-port-border p-3 text-sm">
      <p>A repair calls <strong>{settings.providerId || 'no provider selected'}</strong> · {settings.model || 'default model'} · effort {settings.effort || 'unspecified'}.</p>
      <p className="text-xs text-gray-400">Budgets: {formatCount(project.budgets.iterations)} repairs · {formatCount(project.budgets.timeSeconds)}s · {formatCount(project.budgets.tokens)} tokens · {formatCount(project.budgets.renderSeconds)}s render.</p>
      {canReview
        ? <div className="flex items-center gap-2">
          <input id="cap-visual-review" type="checkbox" checked={visualReview} onChange={event => setVisualReview(event.target.checked)} />
          <label htmlFor="cap-visual-review" className="text-sm">Also send the style frames to this route for a visual review (advisory)</label>
        </div>
        : <p className="text-xs text-gray-400">This route does not accept images, so style fit stays unverified.</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={buttonClass} disabled={busy} onClick={() => start(visualReview ? { visualReview: true } : {})}>Start run</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => setConfirming(false)}>Not now</button>
      </div>
    </div>}
    <ul className="space-y-2">
      {runs.map(run => <StageRun key={run.id} run={run} busy={busy}
        onCancel={runId => act(async () => cancelCodeAnimationStageRun(project.id, runId, { silent: true }))}
        onResume={runId => start({ resumeFromRunId: runId })} />)}
    </ul>
  </section>;
}
