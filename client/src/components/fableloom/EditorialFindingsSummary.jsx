import { Link } from 'react-router';
import { AlertTriangle, CheckCircle2, Waypoints } from 'lucide-react';

function Metric({ label, value, tone = 'default' }) {
  const valueClass = tone === 'good'
    ? 'text-port-success'
    : tone === 'bad' ? 'text-port-error' : 'text-port-text';
  return (
    <div className="rounded border border-port-border bg-port-bg/40 px-3 py-2">
      <p className="text-[11px] text-port-text-muted">{label}</p>
      <p className={`mt-0.5 text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}

function FindingLink({ loom, finding }) {
  const episode = loom.episodes.find((candidate) => candidate.id === finding.episodeId);
  const scene = episode?.nodes?.find((candidate) => candidate.id === finding.nodeId);
  const target = episode
    ? `/fableloom/${encodeURIComponent(loom.id)}/${encodeURIComponent(episode.id)}${scene ? `/${encodeURIComponent(scene.id)}` : ''}`
    : null;
  const severity = finding.severity === 'error' ? 'high' : finding.severity;
  const Icon = severity === 'high' ? AlertTriangle : Waypoints;
  return (
    <li className="rounded border border-port-border px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Icon
          size={13}
          className={`mt-0.5 shrink-0 ${severity === 'high' ? 'text-port-error' : 'text-port-warning'}`}
        />
        <div className="min-w-0 flex-1">
          <p>{finding.problem || finding.message}</p>
          {finding.suggestion ? <p className="mt-1 text-port-text-muted">{finding.suggestion}</p> : null}
          {target ? (
            <Link to={target} className="mt-1 inline-block text-port-accent hover:underline">
              Episode {episode.number || loom.episodes.indexOf(episode) + 1}{scene ? ` · ${scene.title || 'Scene'}` : ''}
            </Link>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function readEditorialResult(result, shownRun) {
  const response = result?.response;
  const diagnostics = result?.type === 'remediation' ? response?.diagnostics : null;
  const deterministic = result?.type === 'playtest'
    ? response?.deterministic
    : diagnostics?.playthrough || shownRun?.lastPlaytest;
  const stats = deterministic?.stats;
  const remediationStats = result?.type === 'remediation'
    ? response?.after
    : shownRun?.rounds?.at(-1)?.after;
  const review = result?.type === 'playtest' ? response?.review : shownRun?.lastReview;
  const evaluation = result?.type === 'remediation' ? response?.evaluation : shownRun?.lastEvaluation;
  const summary = shownRun?.message || review?.summary || evaluation?.summary;
  const passed = result?.type === 'playtest'
    ? response?.passed
    : shownRun?.status === 'completed' || diagnostics?.passed;
  return { stats, remediationStats, review, evaluation, summary, passed };
}

function EditorialMetrics({ stats, remediationStats, review }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      {remediationStats ? (
        <>
          <Metric label="Outline blockers" value={remediationStats.outlineErrors} tone={remediationStats.outlineErrors ? 'bad' : 'good'} />
          <Metric label="Graph blockers" value={remediationStats.graphErrors} tone={remediationStats.graphErrors ? 'bad' : 'good'} />
          <Metric label="Convergence gaps" value={remediationStats.convergenceIssues} tone={remediationStats.convergenceIssues ? 'bad' : 'good'} />
        </>
      ) : null}
      {stats ? (
        <>
          <Metric label="Variations tested" value={stats.variationCount} />
          <Metric
            label="Path coverage"
            value={`${stats.visitedTransitionCount}/${stats.transitionCount}`}
            tone={stats.visitedTransitionCount === stats.transitionCount ? 'good' : 'bad'}
          />
        </>
      ) : null}
      {review?.qualityScore != null ? (
        <Metric label="Story quality" value={`${review.qualityScore}/10`} tone={review.qualityScore >= 8 ? 'good' : 'bad'} />
      ) : null}
    </div>
  );
}

function AutopilotRunDetails({ run }) {
  return (
    <>
      {run?.rounds?.length ? (
        <p className="text-[11px] text-port-text-muted">
          {run.rounds.length} bounded editorial round{run.rounds.length === 1 ? '' : 's'} recorded. The run stops on success, plateau, cancellation, provider failure, or the selected round limit.
        </p>
      ) : null}
      {run?.invalidResponses ? (
        <p className="text-[11px] text-port-text-muted">
          {run.status === 'failed'
            ? `Autopilot safely rejected ${run.invalidResponses} invalid editor responses; no invalid changes were applied.`
            : `Autopilot safely rejected and retried ${run.invalidResponses} invalid editor response${run.invalidResponses === 1 ? '' : 's'} before continuing.`}
        </p>
      ) : null}
      {run?.selfImprove?.verdict === 'pipeline' ? (
        <div className="rounded border border-port-accent/30 bg-port-accent/5 px-3 py-2 text-xs text-port-accent">
          <p>
            {run.selfImprove.duplicate
              ? `FableLoom improvement already tracked (${run.selfImprove.area}): ${run.selfImprove.title}`
              : run.selfImprove.filed
                ? `Queued a FableLoom improvement (${run.selfImprove.area}): ${run.selfImprove.title}`
                : `Diagnosed a FableLoom workflow defect (${run.selfImprove.area}), but task filing failed: ${run.selfImprove.title}`}
          </p>
          {run.selfImprove.taskId ? (
            <Link
              to={`/cos/tasks?task=${encodeURIComponent(run.selfImprove.taskId)}&source=internal`}
              className="mt-1 inline-block font-medium hover:underline"
            >
              Review CoS task
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export default function EditorialFindingsSummary({ loom, result, shownRun }) {
  const { stats, remediationStats, review, evaluation, summary, passed } = readEditorialResult(result, shownRun);
  const findings = result?.type === 'autopilot' || shownRun?.status
    ? shownRun?.residualFindings || []
    : review?.findings?.length ? review.findings : evaluation?.findings || [];
  const resultHeading = passed
    ? (shownRun?.mode === 'planning' ? 'Series planning is ready for scene expansion' : 'Series clears the current editorial gates')
    : shownRun?.status === 'failed'
      ? 'Editorial automation needs attention'
      : shownRun?.status === 'canceled'
        ? 'Editorial autopilot stopped'
        : 'Editorial work remains';
  if (!(stats || remediationStats || review || evaluation || shownRun)) return null;
  return (
    <div className="space-y-3 border-t border-port-border pt-4" aria-label="Editorial automation results">
      <div className="flex items-start gap-2">
        {passed ? (
          <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-port-success" />
        ) : (
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-port-warning" />
        )}
        <div>
          <p className="text-sm font-medium">
            {resultHeading}
          </p>
          {summary ? <p className="mt-1 text-xs text-port-text-muted">{summary}</p> : null}
        </div>
      </div>
      <EditorialMetrics stats={stats} remediationStats={remediationStats} review={review} />
      {evaluation?.strengths?.length || review?.strengths?.length ? (
        <p className="text-xs text-port-text-muted">
          <span className="font-medium text-port-text">Strengths:</span>{' '}
          {(review?.strengths?.length ? review.strengths : evaluation.strengths).join(' · ')}
        </p>
      ) : null}
      {findings.length ? (
        <ul className="space-y-2">
          {findings.slice(0, 12).map((finding, index) => (
            <FindingLink
              key={`${finding.episodeId || 'series'}-${finding.nodeId || finding.pathId || index}-${index}`}
              loom={loom}
              finding={finding}
            />
          ))}
        </ul>
      ) : null}
      <AutopilotRunDetails run={shownRun} />
    </div>
  );
}
