import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ClipboardCheck, Loader2, CheckCircle2, AlertCircle, AlertTriangle, Wrench,
  ThumbsUp, X, MessageSquarePlus, ChevronRight,
} from 'lucide-react';
import toast from '../ui/Toast';
import { usePipelineProgress } from '../../hooks/usePipelineProgress';
import { severityRank } from '../../lib/editorialChecks';
import {
  startPipelineSeriesReview,
  getPipelineSeriesReview,
  getPipelineSeriesReviewStatus,
  cancelPipelineSeriesReview,
  pipelineSeriesReviewSseUrl,
  startPipelineSeriesFix,
  getPipelineSeriesFixStatus,
  pipelineSeriesFixSseUrl,
  getPipelineSeries,
  listPipelineIssues,
} from '../../services/api';

const SEVERITY_STYLES = {
  high: 'text-port-error border-port-error/40 bg-port-error/10',
  medium: 'text-port-warning border-port-warning/40 bg-port-warning/10',
  low: 'text-gray-400 border-gray-500/30 bg-gray-700/20',
};

const RUN_ENDED = new Set(['complete', 'canceled', 'error']);
// The fix run's terminal frames: `rejected` = the cos gate/budget refused it.
const FIX_RUN_ENDED = new Set(['complete', 'canceled', 'error', 'rejected']);

// One-line label for a review SSE frame (mirrors AutopilotPanel's frameLabel,
// scoped to this flow's steps).
const REVIEW_STEP_LABELS = {
  foundation: 'Judging foundation',
  feedback: 'Routing your feedback',
  editorialChecks: 'Running editorial checks',
  canon: 'Checking canon descriptions',
  health: 'Scoring editorial health',
};
function reviewFrameLabel(f) {
  if (!f) return null;
  switch (f.type) {
    case 'start': return 'Starting review…';
    case 'step:start': return `${REVIEW_STEP_LABELS[f.kind] || f.kind}…`;
    case 'step:complete': return `${REVIEW_STEP_LABELS[f.kind] || f.kind} done`;
    case 'check:start': return `Editorial check: ${f.label || f.checkId}…`;
    case 'check:complete': return `Editorial check: ${f.label || f.checkId} — ${f.count ?? 0} finding(s)`;
    case 'complete': return 'Review complete';
    case 'canceled': return 'Review canceled';
    case 'error': return `Review failed — ${f.error}`;
    default: return f.type;
  }
}

// Compact label for the per-finding fix run.
function fixFrameLabel(f) {
  if (!f) return 'Working…';
  switch (f.type) {
    case 'start': return 'Starting fixes…';
    case 'fix:start': return `Fixing ${f.issueNumber != null ? `#${f.issueNumber} ` : ''}finding…`;
    case 'fix:done': return 'Applied a fix…';
    case 'fix:skip': return 'Skipped an unanchorable finding…';
    case 'complete': return `Fixed ${f.fixed ?? 0} of ${f.total ?? 0}`;
    case 'rejected': return 'Fixing unavailable';
    case 'canceled': return 'Fixing canceled';
    case 'error': return `Fixing failed — ${f.error}`;
    default: return 'Fixing…';
  }
}

// Group findings by the issue they'd be patched at (series-wide → null bucket,
// rendered last). Each group is deep-linked to that issue's manuscript section.
function groupFindings(findings) {
  const map = new Map();
  for (const f of Array.isArray(findings) ? findings : []) {
    const key = Number.isInteger(f.issueNumber) ? f.issueNumber : null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(f);
  }
  return [...map.entries()]
    .sort((a, b) => (a[0] ?? Infinity) - (b[0] ?? Infinity))
    .map(([issueNumber, items]) => ({
      issueNumber,
      items: items.sort((x, y) => severityRank(x.severity) - severityRank(y.severity)),
    }));
}

/**
 * Holistic "Review this series" surface (#2664): one action runs the read-only
 * review passes, renders a single verdict with findings grouped by where they'd
 * be patched, and — via an inline confirm — drives the existing autopilot
 * revision cycle (or per-finding fixes) to patch them. No `window.confirm`.
 */
export default function SeriesReviewPanel({ series, onSeriesUpdate, onIssuesUpdate }) {
  const seriesId = series?.id;
  const [feedback, setFeedback] = useState('');
  const [reviewing, setReviewing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [review, setReview] = useState(null);
  const [fixAvail, setFixAvail] = useState(null);
  const [fixing, setFixing] = useState(false);
  const [fixStarting, setFixStarting] = useState(false);
  const [confirmDismissed, setConfirmDismissed] = useState(false);

  const reviewRunIdRef = useRef(null);
  const fixRunIdRef = useRef(null);
  const onSeriesUpdateRef = useRef(onSeriesUpdate);
  const onIssuesUpdateRef = useRef(onIssuesUpdate);
  onSeriesUpdateRef.current = onSeriesUpdate;
  onIssuesUpdateRef.current = onIssuesUpdate;

  const { latest: reviewLatest, frames: reviewFrames } = usePipelineProgress(
    pipelineSeriesReviewSseUrl, [seriesId], { enabled: reviewing },
  );
  const { latest: fixLatest } = usePipelineProgress(
    pipelineSeriesFixSseUrl, [seriesId], { enabled: fixing },
  );

  const loadVerdict = useCallback(async () => {
    if (!seriesId) return;
    const res = await getPipelineSeriesReview(seriesId, { silent: true }).catch(() => null);
    if (!res) return;
    if (res.review) { setReview(res.review); setConfirmDismissed(false); }
    if (res.fix) setFixAvail(res.fix);
  }, [seriesId]);

  // Initial load — restore the last verdict + re-attach to an in-flight review.
  useEffect(() => {
    if (!seriesId) return undefined;
    let canceled = false;
    loadVerdict();
    getPipelineSeriesReviewStatus(seriesId, { silent: true })
      .then((s) => { if (!canceled && s?.active) setReviewing(true); })
      .catch(() => null);
    getPipelineSeriesFixStatus(seriesId, { silent: true })
      .then((s) => { if (!canceled && s?.active) { setConfirmDismissed(true); setFixing(true); } })
      .catch(() => null);
    return () => { canceled = true; };
  }, [seriesId, loadVerdict]);

  // Review run ended — fetch the fresh verdict on success.
  useEffect(() => {
    if (!reviewing || !reviewLatest || !RUN_ENDED.has(reviewLatest.type)) return;
    if (reviewRunIdRef.current && reviewLatest.runId && reviewLatest.runId !== reviewRunIdRef.current) return;
    setReviewing(false);
    if (reviewLatest.type === 'complete') {
      loadVerdict();
      toast.success(reviewLatest.verdict === 'ready' ? 'Review complete — looks ready' : 'Review complete — found issues to address');
    } else if (reviewLatest.type === 'canceled') {
      toast.success('Review canceled');
    } else {
      toast.error(reviewLatest.error || 'Review failed');
    }
  }, [reviewing, reviewLatest, loadVerdict]);

  // Fix run ended — refresh series + issues. The applied fixes changed the
  // manuscript + accepted the findings, so the stored verdict is now stale;
  // clear it so the panel returns to the review action and the user re-reviews
  // to confirm (a fresh review is an explicit LLM action, never auto-fired).
  useEffect(() => {
    if (!fixing || !fixLatest || !FIX_RUN_ENDED.has(fixLatest.type)) return;
    if (fixRunIdRef.current && fixLatest.runId && fixLatest.runId !== fixRunIdRef.current) return;
    setFixing(false);
    if (fixLatest.type === 'complete') {
      getPipelineSeries(seriesId, { silent: true }).then((s) => { if (s) onSeriesUpdateRef.current?.(s); }).catch(() => null);
      listPipelineIssues(seriesId, { silent: true }).then((is) => onIssuesUpdateRef.current?.(Array.isArray(is) ? is : [])).catch(() => null);
      setReview(null);
      setConfirmDismissed(false);
      const fixed = fixLatest.fixed ?? 0;
      toast.success(`Fixed ${fixed} of ${fixLatest.total ?? 0} — re-review to confirm${fixLatest.budgetStopped ? ' (stopped: daily budget reached)' : ''}`);
    } else if (fixLatest.type === 'rejected') {
      toast.error(fixLatest.mode === 'dry-run'
        ? 'Fixing is preview-only right now (CoS auto-run is in dry-run) — set it to execute to apply fixes.'
        : (fixLatest.reason || 'Autonomous fixing is disabled — set the CoS auto-run domain to execute.'));
    } else if (fixLatest.type === 'canceled') {
      toast.success('Fixing canceled');
    } else {
      toast.error(fixLatest.error || 'Fixing failed');
    }
  }, [fixing, fixLatest, seriesId]);

  const runReview = useCallback(async () => {
    setStarting(true);
    // Only submit feedback while the textarea is actually shown (before the first
    // verdict). A Re-review after a verdict must NOT silently re-seed the same
    // stale note — the LLM-routed anchor can vary run-to-run, so it wouldn't dedup.
    const body = (!review && feedback.trim()) ? { feedback: feedback.trim() } : {};
    const res = await startPipelineSeriesReview(seriesId, body, { silent: true })
      .catch((err) => { toast.error(err.message || 'Could not start review'); return null; });
    setStarting(false);
    if (!res) return;
    reviewRunIdRef.current = res.runId || null;
    setReviewing(true);
  }, [seriesId, feedback, review]);

  const cancelReview = useCallback(async () => {
    await cancelPipelineSeriesReview(seriesId, { silent: true }).catch(() => null);
  }, [seriesId]);

  const startFix = useCallback(async () => {
    setFixStarting(true);
    // Patch each open finding at its anchor via the per-finding manuscriptFix
    // machinery (server-side, cos-execute-gated + budgeted). Not the autopilot —
    // that only auto-resolves completeness findings, so it can't fix the
    // editorial-check findings this review surfaced.
    const res = await startPipelineSeriesFix(seriesId, {}, { silent: true })
      .catch((err) => { toast.error(err?.message || 'Could not start fixing'); return null; });
    setFixStarting(false);
    if (!res) return;
    fixRunIdRef.current = res.runId || null;
    setConfirmDismissed(true);
    setFixing(true);
    toast.success('Fixing started — patching findings at their anchors');
  }, [seriesId]);

  if (!seriesId) return null;

  const reviewLabel = reviewing ? (reviewFrameLabel(reviewLatest) || 'Working…') : null;
  const groups = review ? groupFindings(review.findings) : [];
  const hasIssues = review?.verdict === 'issues';
  const canFix = fixAvail?.canFix !== false;
  const showConfirm = hasIssues && !confirmDismissed && !fixing && !reviewing;

  return (
    <div className="border border-port-border rounded-lg bg-port-card/40">
      <div className="flex items-center gap-2 flex-wrap p-3">
        <ClipboardCheck size={15} className="text-port-accent" />
        <span className="text-sm font-medium text-white">Review this series</span>
        <span className="text-xs text-gray-500">runs every check, tells you what&apos;s wrong, then fixes it where best patched</span>

        <div className="ml-auto flex items-center gap-2">
          {!reviewing ? (
            <button
              type="button"
              onClick={runReview}
              disabled={starting}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-sm font-medium border bg-port-bg text-port-accent border-port-border hover:border-port-accent/40 disabled:opacity-40"
            >
              {starting ? <Loader2 size={14} className="animate-spin" /> : <ClipboardCheck size={14} />}
              {review ? 'Re-review' : 'Review series'}
            </button>
          ) : (
            <button
              type="button"
              onClick={cancelReview}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs text-port-warning hover:text-white border border-port-warning/40 bg-port-bg hover:bg-port-warning/10"
            >
              <X size={12} /> Stop
            </button>
          )}
        </div>
      </div>

      {/* Optional free-text feedback */}
      {!reviewing && !review ? (
        <div className="px-3 pb-3 flex flex-col gap-1">
          <label htmlFor="series-review-feedback" className="text-xs text-gray-400 flex items-center gap-1.5">
            <MessageSquarePlus size={12} /> Anything specific you want the reviewer to look at or fix? (optional)
          </label>
          <textarea
            id="series-review-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            rows={2}
            maxLength={4000}
            placeholder="e.g. Volume 1 looks complete but little actually develops — check the pacing."
            className="w-full px-2 py-1.5 rounded text-xs bg-port-bg border border-port-border text-gray-200 resize-y"
          />
        </div>
      ) : null}

      {/* Live review progress */}
      {reviewing ? (
        <div className="px-3 pb-3 border-t border-port-border pt-2">
          <div className="text-xs text-gray-300 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-port-accent" />
            {reviewLabel}
          </div>
          {reviewFrames?.length ? (
            <div className="mt-2 max-h-24 overflow-y-auto text-[11px] text-gray-500 space-y-0.5">
              {reviewFrames.slice(-6).map((f, i) => <div key={i}>{reviewFrameLabel(f)}</div>)}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Verdict + findings */}
      {review && !reviewing ? (
        <div className="px-3 pb-3 border-t border-port-border pt-2 space-y-3">
          {/* Headline verdict */}
          <div className="flex items-center gap-2 text-sm">
            {review.verdict === 'ready' ? (
              <><CheckCircle2 size={15} className="text-port-success" /><span className="text-port-success">Looks ready to move forward.</span></>
            ) : (
              <><AlertTriangle size={15} className="text-port-warning" /><span className="text-port-warning">{review.findingCount || 0} issue(s) to address before moving forward.</span></>
            )}
          </div>

          {/* Signal chips */}
          <div className="flex flex-wrap gap-2 text-[11px]">
            {review.foundation && Number.isFinite(review.foundation.weightedScore) ? (
              <span className="px-2 py-0.5 rounded border border-port-border bg-port-bg text-gray-300" title={review.foundation.oneLineVerdict || ''}>
                Foundation {review.foundation.weightedScore}/10{review.foundation.weakest ? ` · weakest: ${review.foundation.weakest}` : ''}
              </span>
            ) : null}
            {review.health && Number.isFinite(review.health.score) ? (
              <span className={`px-2 py-0.5 rounded border ${review.health.ready ? 'border-port-success/40 text-port-success' : 'border-port-warning/40 text-port-warning'} bg-port-bg`}>
                Health {review.health.score}/100{review.health.ready ? ' · clean' : ''}
              </span>
            ) : null}
            {review.canon ? (
              <span className={`px-2 py-0.5 rounded border ${review.canon.ready ? 'border-port-success/40 text-port-success' : 'border-port-warning/40 text-port-warning'} bg-port-bg`}>
                Canon {review.canon.ready ? 'described' : `${review.canon.undescribed?.length || 0} undescribed`}
              </span>
            ) : null}
          </div>

          {/* Incomplete-review warning — a requested check errored, so this
              verdict is not trustworthy as "ready" (P2). */}
          {review.checksErrored > 0 ? (
            <p className="text-[11px] text-port-warning flex items-center gap-1.5">
              <AlertTriangle size={12} />
              {review.checksErrored} editorial check(s) errored (e.g. a provider was unavailable) — this review is incomplete; re-run before trusting it.
            </p>
          ) : null}

          {/* Findings grouped by where they'd be patched */}
          {groups.length ? (
            <div className="space-y-2">
              {groups.map((g) => (
                <div key={g.issueNumber ?? 'series'} className="text-xs">
                  <div className="uppercase tracking-wider text-gray-500 mb-1">
                    {g.issueNumber != null ? (
                      <Link to={`/pipeline/series/${seriesId}/manuscript/${g.issueNumber}`} className="text-port-accent hover:underline">
                        #{g.issueNumber} →
                      </Link>
                    ) : 'Series-wide'}
                  </div>
                  <ul className="space-y-1">
                    {g.items.map((f) => (
                      <li key={f.commentId} className={`p-2 rounded border ${SEVERITY_STYLES[f.severity] || SEVERITY_STYLES.medium}`}>
                        <div className="flex items-center gap-2">
                          <AlertCircle size={11} />
                          <span className="uppercase tracking-wider font-semibold text-[10px]">{f.severity}</span>
                          {f.checkId ? <span className="text-gray-500 text-[10px]">{f.checkId}</span> : null}
                          <Link
                            to={`/pipeline/findings/${f.commentId}`}
                            className="ml-auto inline-flex items-center gap-0.5 text-port-accent hover:underline text-[10px]"
                            title="Open this finding in the manuscript editor to generate and accept a fix"
                          >
                            Fix here <ChevronRight size={10} />
                          </Link>
                        </div>
                        <p className="text-gray-200 mt-0.5">{f.summary}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : null}

          {/* Inline confirm — "good to move forward?" (no window.confirm) */}
          {showConfirm ? (
            <div className="rounded border border-port-border bg-port-bg p-2 flex items-center gap-2 flex-wrap">
              <span className="text-xs text-gray-300">Is the story so far good to move forward?</span>
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmDismissed(true)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs text-gray-300 hover:text-white border border-port-border hover:border-port-success/40"
                >
                  <ThumbsUp size={12} /> Looks good
                </button>
                <button
                  type="button"
                  onClick={startFix}
                  disabled={fixStarting || !canFix}
                  title={canFix ? 'Patch each finding at its anchor via the per-finding manuscript fixer' : 'Auto-fixing needs the CoS auto-run domain set to execute'}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium text-port-accent border border-port-border bg-port-bg hover:border-port-accent/40 disabled:opacity-40"
                >
                  {fixStarting ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />} Fix these issues
                </button>
              </div>
              {!canFix ? (
                <p className="w-full text-[11px] text-gray-500 mt-1">
                  {fixAvail?.mode === 'dry-run'
                    ? 'Auto-fixing is preview-only right now (CoS auto-run is in dry-run — it makes no changes). Set it to execute, or open each finding above and fix it manually.'
                    : 'Auto-fixing is off (CoS auto-run domain is disabled). You can still open each finding above and fix it manually.'}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Fix run progress */}
      {fixing ? (
        <div className="px-3 pb-3 border-t border-port-border pt-2">
          <div className="text-xs text-gray-300 flex items-center gap-2">
            <Loader2 size={12} className="animate-spin text-port-accent" />
            {fixFrameLabel(fixLatest)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
