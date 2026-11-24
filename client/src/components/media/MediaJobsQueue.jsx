import { useMemo, useState, useEffect, useRef } from 'react';
import { ListOrdered, RefreshCw, ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import BrailleSpinner from '../BrailleSpinner';
import toast from '../ui/Toast';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import CollapsibleListItem from '../ui/CollapsibleListItem';
import { listQueueMediaJobs, cancelMediaJob, cancelQueuedMediaJobs, deleteMediaJob, deleteFailedCanceledMediaJobs, retryMediaJob, runMediaJobNow, listMediaVideoHolds, resumeMediaVideoHold } from '../../services/apiMediaJobs.js';
import { mediaJobLane } from '../../lib/imageGenBackends';
import { useSocketResource } from '../../hooks/useSocketResource';
import { formatCount } from '../../utils/formatters';
import JobRow from './MediaJobRow';

const QUEUE_EVENTS = ['media-jobs:changed'];

// Video jobs are scheduled by the server into independent execution lanes.
// Keep the UI labels aligned with the user-facing targets rather than exposing
// implementation names such as "gpu" and "cloud". The lane a row belongs to is
// the server's own scheduling decision, read via `mediaJobLane` — the queue
// must never keep a second list of cloud backends, which is exactly how fal.ai
// and Reactor renders ended up filed under Local machine. Cloud providers share
// one section; each provider is its own server swim lane, so a row's position
// counts only work from the same provider.
const VIDEO_QUEUE_LANES = Object.freeze([
  { id: 'gpu', label: 'Local machine', description: 'Local GPU renders stay at their memory-governed limit (1 at a time).' },
  { id: 'cloud', label: 'Cloud renders', description: 'Each cloud provider has its own lane, running in parallel with local work and other providers.' },
  { id: 'remote', label: 'Remote machines', description: 'Each selected peer owns the queue for work it receives.' },
]);


// Embeds the live render queue inline on the Image / Video gen pages so the
// user can watch in-flight jobs (and cancel them) without leaving the page.
// Completed jobs are excluded from the recent reel — those render as preview
// cards on the gen page already, so listing them here is duplicate noise.
export default function MediaJobsQueue({ kind, recentLimit = 10, className = '', allowClearFailed = kind === 'image' || kind === 'video' }) {
  const [showRecent, setShowRecent] = useState(false);
  const [resumingHold, setResumingHold] = useState(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [exitingJobs, setExitingJobs] = useState([]);
  const clearInFlight = useRef(false);
  const deferredQueueEvent = useRef(false);
  const pendingExits = useRef(new Set());
  const queueRef = useRef(null);
  const clearControlsRef = useRef(null);
  const clearButtonRef = useRef(null);
  const restoreClearFocus = useRef(false);
  const { data, loading, error, refetch: fetchJobs, updateData } = useSocketResource(async () => {
    const snapshotRequestedAt = performance.now();
    const [jobs, holds] = await Promise.all([
      listQueueMediaJobs({ ...(kind ? { kind } : {}), limit: recentLimit }),
      !kind || kind === 'video' ? listMediaVideoHolds() : [],
    ]);
    if (!Array.isArray(jobs) || !Array.isArray(holds)) throw new Error('Invalid queue snapshot');
    return { jobs, holds, snapshotRequestedAt };
  }, {
    namespace: 'media-jobs',
    events: QUEUE_EVENTS,
    resourceKey: JSON.stringify([kind, recentLimit]),
    matchesEvent: () => {
      if (!clearInFlight.current) return true;
      deferredQueueEvent.current = true;
      return false;
    },
  });
  const jobs = data?.jobs ?? [];
  const holds = data?.holds ?? [];
  const hasSnapshot = data !== null;
  const loadError = !!error;
  const setJobs = (updater) => updateData(previous => ({
    ...previous,
    jobs: updater(previous?.jobs ?? []), holds: previous?.holds ?? [],
  }));
  const setHolds = (updater) => updateData(previous => ({
    ...previous,
    jobs: previous?.jobs ?? [], holds: updater(previous?.holds ?? []),
  }));

  const handleCancel = (id) => cancelMediaJob(id, { silent: true })
    .then((result) => {
      // Optimistic update: queued jobs flip to 'canceled' immediately (the
      // worker won't pick them up). For running jobs leave the server status
      // alone; the next queue refresh replaces this optimistic flag with the
      // server-projected `cancelRequested` state until the job is terminal.
      setJobs((prev) => prev.map((j) => {
        if (j.id !== id) return j;
        if (j.status === 'queued' && result.status === 'canceled') return { ...j, status: 'canceled', cancelRequested: false };
        return { ...j, cancelRequested: true };
      }));
      toast.success('Cancel requested');
    })
    .catch((err) => toast.error(err?.message || 'Cancel failed'));

  const { live, recent, queuedCount, failedCount } = useMemo(() => {
    const liveJobs = [];
    const recentJobs = [];
    let queued = 0;
    let failed = 0;
    for (const j of jobs) {
      if (j.status === 'queued' || j.status === 'running') {
        liveJobs.push(j);
        if (j.status === 'queued') queued += 1;
      } else if ((j.status === 'failed' || j.status === 'canceled' || (kind === 'video-upscale' && j.status === 'completed')) && (j.result?.topazUncertain || j.result?.topazRecoveryAvailable || recentJobs.length < recentLimit)) {
        recentJobs.push(j);
        if (j.status === 'failed') failed += 1;
      }
    }
    return { live: liveJobs, recent: recentJobs, queuedCount: queued, failedCount: failed };
  }, [jobs, recentLimit, kind]);

  const videoLanes = useMemo(() => {
    if (kind !== 'video') return [];
    return VIDEO_QUEUE_LANES
      .map((lane) => ({ ...lane, jobs: live.filter((job) => mediaJobLane(job) === lane.id) }))
      .filter((lane) => lane.jobs.length > 0);
  }, [kind, live]);

  // Accepts optional `overrides` so the inline Edit form can patch prompt /
  // negativePrompt / model / dimensions before the re-enqueue. No overrides =
  // same behavior as the plain Retry button.
  const handleRetry = (id, overrides = null) => retryMediaJob(id, overrides, { silent: true })
    .then(({ jobId }) => {
      toast.success(`Re-queued as ${jobId.slice(0, 8)}${overrides ? ' (edited)' : ''}`);
      // Optimistic: drop the original failed/canceled row immediately. The
      // server's retry endpoint already prunes it from the archive, but the
      // next event read would otherwise leave the stale row + button visible.
      setJobs((prev) => prev.filter((j) => j.id !== id));
      fetchJobs();
    })
    .catch((err) => toast.error(err?.message || 'Retry failed'));

  const handleRunNow = (id) => runMediaJobNow(id, { silent: true })
    .then(() => {
      toast.success('Started in parallel');
      fetchJobs();
    })
    .catch((err) => toast.error(err?.message || 'Run-now failed'));

  const handleResume = (id) => {
    setResumingHold(id);
    return resumeMediaVideoHold(id, { silent: true })
      .then(() => {
        setJobs((previous) => previous.map((job) => job.hold?.id === id ? { ...job, hold: undefined } : job));
        setHolds((previous) => previous.filter((hold) => hold.id !== id));
        toast.success('Retained video jobs resumed');
        fetchJobs();
      })
      .catch((error) => toast.error(error?.message || 'Resume failed'))
      .finally(() => setResumingHold(null));
  };

  const handleDelete = (id) => deleteMediaJob(id, { silent: true })
    .then(() => {
      setJobs((prev) => prev.filter((j) => j.id !== id));
    })
    .catch((err) => toast.error(err?.message || 'Delete failed'));

  const finishClear = () => {
    if (clearControlsRef.current?.contains(document.activeElement)) queueRef.current?.focus({ preventScroll: true });
    clearInFlight.current = false;
    setClearing(false);
    setConfirmClear(false);
    if (deferredQueueEvent.current) {
      deferredQueueEvent.current = false;
      fetchJobs();
    }
  };

  useEffect(() => {
    if (!confirmClear && restoreClearFocus.current) {
      restoreClearFocus.current = false;
      (clearButtonRef.current || queueRef.current)?.focus({ preventScroll: true });
    }
  }, [confirmClear]);

  const handleClearFailed = () => {
    if (clearInFlight.current) return;
    clearInFlight.current = true;
    setClearing(true);
    // Invalidate any read that began before the delete request.
    setJobs((previous) => previous);
    deleteFailedCanceledMediaJobs(kind, { silent: true })
      .then(({ deletedIds, skipped, warning }) => {
        const deleted = new Set(deletedIds);
        const exiting = showRecent
          ? recent.flatMap((job, index) => deleted.has(job.id) ? [{ job, index }] : [])
          : [];
        pendingExits.current = new Set(exiting.map(({ job }) => job.id));
        setExitingJobs(exiting);
        setJobs((previous) => previous.filter((job) => !deleted.has(job.id)));
        if (skipped || warning) {
          const skippedNote = skipped ? `; ${formatCount(skipped)} could not be removed. Retry or review them individually.` : '.';
          toast.error(`Removed ${formatCount(deleted.size)} job${deleted.size === 1 ? '' : 's'}${skippedNote}${warning ? ` ${warning}` : ''}`);
        } else if (deleted.size) {
          toast.success(`Removed ${formatCount(deleted.size)} failed or canceled job${deleted.size === 1 ? '' : 's'}`);
        } else {
          toast('No failed or canceled jobs to remove');
        }
        // An empty result can mean another view already removed the snapshot.
        if (!deleted.size) deferredQueueEvent.current = true;
        if (!exiting.length) finishClear();
      })
      .catch((err) => {
        toast.error(err?.message || 'Could not remove failed or canceled jobs');
        finishClear();
      });
  };

  const finishExit = (id) => {
    pendingExits.current.delete(id);
    setExitingJobs((previous) => previous.filter(({ job }) => job.id !== id));
    if (!pendingExits.current.size) finishClear();
  };

  const displayedRecent = [...recent];
  for (const entry of exitingJobs) displayedRecent.splice(Math.min(entry.index, displayedRecent.length), 0, entry.job);
  // Completed upscales can fill the bounded reel while older failures remain.
  const canClearFailed = allowClearFailed && (kind === 'video-upscale'
    ? recent.length > 0
    : recent.some((job) => job.status === 'failed' || job.status === 'canceled'));
  useEffect(() => {
    if (!clearing && !canClearFailed) setConfirmClear(false);
  }, [clearing, canClearFailed]);
  const KIND_LABEL = { image: 'Image', video: 'Video', 'video-upscale': 'Upscale', training: 'Training' };
  const headerLabel = kind
    ? `${KIND_LABEL[kind] || ''} ${kind === 'training' ? 'Queue' : kind === 'video' ? 'Render Queues' : 'Render Queue'}`.trim()
    : 'Render Queue';

  const handleClearQueued = () => {
    if (!queuedCount) return;
    cancelQueuedMediaJobs(kind ? { kind } : {}, { silent: true })
      .then(({ canceled }) => {
        // Optimistic flip: queued → canceled (running jobs stay untouched).
        // The queue change event reconciles anything that raced through.
        setJobs((prev) => prev.map((j) => (j.status === 'queued' ? { ...j, status: 'canceled' } : j)));
        toast.success(`Cleared ${canceled} queued job${canceled === 1 ? '' : 's'}`);
      })
      .catch((err) => toast.error(err?.message || 'Clear failed'));
  };

  return (
    <div ref={queueRef} tabIndex={-1} className={`bg-port-card border border-port-border rounded-xl p-4 space-y-2 ${className}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ListOrdered className="w-4 h-4 text-port-accent shrink-0" />
          <h2 className="text-xs font-medium text-gray-400 uppercase tracking-wide truncate">{headerLabel}</h2>
          <span className="text-xs text-port-text-muted">
            {loadError && !hasSnapshot ? 'status unavailable' : formatCounts(live, recent, failedCount)}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {queuedCount > 0 && kind !== 'video-upscale' && (
            <button
              onClick={handleClearQueued}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs text-gray-300 hover:text-port-error hover:bg-port-error/10 border border-port-border hover:border-port-error/40"
              title={`Cancel all ${queuedCount} queued job${queuedCount === 1 ? '' : 's'} (running jobs are not affected)`}
            >
              <Trash2 className="w-3 h-3" />
              <span>Clear queued ({queuedCount})</span>
            </button>
          )}
          <button
            onClick={fetchJobs}
            disabled={clearing}
            className="min-h-[44px] min-w-[44px] inline-flex items-center justify-center p-1.5 rounded text-gray-400 hover:text-white hover:bg-port-border/50"
            title="Refresh" aria-label="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {loadError && hasSnapshot && (
        <div className="rounded border border-port-warning/30 bg-port-warning/10 px-3 py-2 text-xs text-port-warning">
          Queue refresh failed. Showing the last known snapshot.
        </div>
      )}

      {holds.map((hold) => (
        <div key={hold.id} role="status" className="rounded border border-port-warning/30 bg-port-warning/10 p-3 text-sm">
          <div className="font-medium text-port-warning">{hold.heldJobCount} video job{hold.heldJobCount === 1 ? '' : 's'} held</div>
          <div className="text-xs text-port-text-muted break-words">{hold.scope === 'local-video' ? 'All local video' : `${hold.modelId} · ${hold.runtime}`}</div>
          <p className="mt-1 break-words">{hold.cause}</p>
          {hold.scope !== 'local-video' && <p className="mt-1 text-xs text-port-text-muted">Three matching failures. Repair the runtime, then resume the retained jobs.</p>}
          <button type="button" disabled={resumingHold !== null} onClick={() => handleResume(hold.id)}
            className="mt-2 min-h-[44px] rounded border border-port-border px-3 py-2 text-sm hover:bg-port-border disabled:opacity-50">
            {resumingHold === hold.id ? 'Resuming…' : hold.scope === 'local-video' ? 'Resume all local video' : 'Resume'}
          </button>
        </div>
      ))}

      {loading && !hasSnapshot ? (
        <div className="text-xs"><BrailleSpinner text="Loading…" /></div>
      ) : loadError && !hasSnapshot ? (
        <div className="text-xs text-port-warning">Queue status unavailable.</div>
      ) : live.length === 0 && displayedRecent.length === 0 ? (
        <div className="text-port-text-muted text-xs">
          No {kind || 'media'} {kind === 'training' ? 'runs' : 'renders'} queued.
        </div>
      ) : (
        <div className="space-y-2">
          {kind === 'video' ? (
            <div className="space-y-3">
              {videoLanes.map((lane) => (
                <section
                  key={lane.id}
                  aria-label={`${lane.label} video queue`}
                  className="space-y-1.5"
                  title={lane.description}
                >
                  <div className="flex items-center justify-between gap-2 px-1">
                    <h3 className="text-[11px] font-medium text-gray-300 uppercase tracking-wide">{lane.label}</h3>
                    <span className="text-[11px] text-port-text-muted">{formatLaneCounts(lane.jobs)}</span>
                  </div>
                  {lane.jobs.map((j) => (
                    <JobRow key={j.id} job={j} snapshotRequestedAt={data?.snapshotRequestedAt} onCancel={handleCancel} onRetry={handleRetry} onRunNow={handleRunNow} />
                  ))}
                </section>
              ))}
            </div>
          ) : (
            live.map((j) => <JobRow key={j.id} job={j} snapshotRequestedAt={data?.snapshotRequestedAt} onCancel={handleCancel} onRetry={handleRetry} onRunNow={handleRunNow} />)
          )}

          {displayedRecent.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={clearing}
                onClick={() => setShowRecent((s) => !s)}
                className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-300 pt-1 disabled:opacity-50"
              >
                {showRecent ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                {showRecent ? 'Hide' : 'Show'} {kind === 'video-upscale' ? 'completed / failed / canceled' : 'failed / canceled'} ({displayedRecent.length})
              </button>
              {(canClearFailed || confirmClear) && (
                <div ref={clearControlsRef} tabIndex={-1}>
                  {confirmClear ? (
                    <ConfirmButtonPair prompt="Remove all failed and canceled jobs?" confirmText="Remove all" className="flex-wrap" responsiveTouchTargets
                      ariaLabel="Confirm clearing failed and canceled jobs" busy={clearing} busyText="Removing…"
                      onConfirm={handleClearFailed} onCancel={() => {
                        restoreClearFocus.current = true;
                        clearControlsRef.current?.focus({ preventScroll: true });
                        setConfirmClear(false);
                      }} />
                  ) : (
                    <button ref={clearButtonRef} type="button" onClick={() => {
                      clearControlsRef.current?.focus({ preventScroll: true });
                      setConfirmClear(true);
                    }}
                      title="Remove all failed and canceled jobs, including older jobs"
                      className="flex min-h-[44px] items-center gap-1 rounded border border-port-border px-2 py-1 text-xs text-gray-300 hover:border-port-error/40 hover:text-port-error pointer-fine:sm:min-h-9">
                      <Trash2 className="w-3 h-3" /> Clear failed / canceled
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
          {showRecent && (
            <div tabIndex={-1}>
              {displayedRecent.map((j) => (
                <CollapsibleListItem key={j.id} removing={pendingExits.current.has(j.id)} onExited={() => finishExit(j.id)}>
                  <div inert={clearing || undefined}>
                    <JobRow job={j} onCancel={handleCancel} onRetry={handleRetry} onDelete={handleDelete} />
                  </div>
                </CollapsibleListItem>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatCounts(live, recent, failedCount) {
  const parts = [`${formatCount(live.length)} active`];
  if (failedCount > 0) parts.push(`${formatCount(failedCount)} failed`);
  const canceledCount = recent.filter((job) => job.status === 'canceled').length;
  const completedCount = recent.filter((job) => job.status === 'completed').length;
  if (canceledCount > 0) parts.push(`${formatCount(canceledCount)} canceled`);
  if (completedCount > 0) parts.push(`${formatCount(completedCount)} completed`);
  return parts.join(' • ');
}

function formatLaneCounts(jobs) {
  const running = jobs.filter((job) => job.status === 'running').length;
  const queued = jobs.filter((job) => job.status === 'queued').length;
  return [
    running > 0 ? `${running} running` : null,
    queued > 0 ? `${queued} queued` : null,
  ].filter(Boolean).join(' · ');
}
