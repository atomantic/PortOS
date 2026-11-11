import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { RefreshCw, ScrollText, Square } from 'lucide-react';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { useTimeTick } from '../../../hooks/useTimeTick.js';
import { BLENDER_JOB_PARAM, BLENDER_TAB_PARAM, blenderSyncJob, isBlenderJobActive } from '../../../lib/musicVideoBlender.js';
import { formatCount, formatDateTime, formatDurationMs, timeAgo } from '../../../utils/formatters.js';
import { buttonCls } from './blenderStyles.js';

const CONFLICT = 'MUSIC_VIDEO_BLENDER_SCENES_CONFLICT';

// How long the film's describe step has been running: the only progress a sync has.
function SyncElapsed({ job }) {
  const now = useTimeTick(1000, { enabled: job.status === 'running' });
  const started = Date.parse(job.startedAt || '');
  if (job.status !== 'running' || !Number.isFinite(started)) return null;
  return <span>{formatDurationMs(Math.max(0, now - started))}</span>;
}

/**
 * "Sync shots from scripts": runs the film's describe step in Blender, lists
 * its shots here and mirrors them to the storyboard. A sync is a background
 * job, so this reads it from the job list: while one runs it shows how long it
 * has taken and can cancel it, and after one fails it shows why (every refused
 * shot or option) with its log one press away. It also says when the last
 * sync was and whether the scripts changed since. A sync that would drop
 * storyboard scenes it does not own is refused by the server; this asks
 * before sending it again with permission to replace them. `showProblems`
 * false keeps it to one row (the Shots tab's reminder).
 */
export default function BlenderSyncControl({ blender, showProblems = true }) {
  const { state, pending } = blender;
  const [, setSearchParams] = useSearchParams();
  const [conflict, setConflict] = useState(null);
  const manifest = state.manifest;
  const job = blenderSyncJob(state);
  const running = isBlenderJobActive(job);
  const starting = !!pending.sync;
  const failed = job?.status === 'error' ? job : null;
  // The Board can also change while describe runs: the same question, asked when the job ends.
  const [declined, setDeclined] = useState(null);
  const question = conflict || (failed?.code === CONFLICT && failed.id !== declined ? failed.error : null);
  const blocker = state.workspace?.hasFilm ? blender.runBlocker?.message : 'Add src/film.py first.';
  const run = async (replaceScenes) => {
    setConflict(null);
    const result = await blender.sync({ replaceScenes });
    if (!result.ok && result.error?.code === CONFLICT) setConflict(result.error.message || 'The storyboard has scenes that are not part of this film.');
  };
  const openLog = (jobId) => setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    next.set(BLENDER_TAB_PARAM, 'jobs');
    next.set(BLENDER_JOB_PARAM, jobId);
    return next;
  });

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-port-text-muted">
        <button type="button" className={buttonCls} disabled={!!blocker || starting || running} onClick={() => run(false)}>
          <RefreshCw size={14} aria-hidden="true" className={starting || running ? 'animate-spin' : ''} />
          {starting || running ? 'Syncing…' : 'Sync shots from scripts'}
        </button>
        {running && (
          <>
            <span role="status" className="inline-flex flex-wrap items-center gap-x-1.5">
              {job.status === 'queued' ? 'Waiting to start' : 'Blender is reading the film'} <SyncElapsed job={job} />
            </span>
            <button type="button" className={buttonCls} disabled={!!pending[`cancel:${job.id}`]} onClick={() => blender.cancelJob(job.id)}>
              <Square size={14} aria-hidden="true" /> {pending[`cancel:${job.id}`] ? 'Canceling…' : 'Cancel sync'}
            </button>
          </>
        )}
        {!running && (manifest?.syncedAt
          ? <span title={formatDateTime(manifest.syncedAt)}>Last synced {timeAgo(manifest.syncedAt)} · {formatCount(manifest.shots?.length ?? 0)} shots</span>
          : <span>Not synced yet</span>)}
        {!running && manifest?.srcChanged && <span role="status" className="text-port-warning">Scripts changed since the last sync</span>}
        {!running && job?.status === 'canceled' && <span role="status" className="text-port-warning">The last sync was canceled; the shot list is unchanged.</span>}
        {blocker && !starting && !running && <span role="status" className="text-port-warning">{blocker}</span>}
      </div>
      {failed && failed.code !== CONFLICT && (
        <div role="alert" className="min-w-0 space-y-1 rounded border border-port-error/30 bg-port-error/5 p-2 text-xs">
          <p className="break-words text-port-error">The last sync failed and the shot list is unchanged: {failed.error}</p>
          {failed.problems?.length > 1 && (
            <ul aria-label="Problems in the film's shot list" className="list-disc space-y-0.5 pl-5">
              {failed.problems.map((problem) => <li key={problem} className="break-words">{problem}</li>)}
            </ul>
          )}
          {failed.logFile && (
            <button type="button" className={buttonCls} onClick={() => openLog(failed.id)}>
              <ScrollText size={14} aria-hidden="true" /> View the sync log
            </button>
          )}
        </div>
      )}
      {question && !running && (
        <InlineConfirmRow
          aria-label="Confirm replacing storyboard scenes"
          question={`${question} Replace them with the film's shots?`}
          confirmText="Replace scenes"
          onConfirm={() => run(true)}
          onCancel={() => { setConflict(null); setDeclined(failed?.id ?? null); }}
        />
      )}
      {showProblems && manifest?.problems?.length > 0 && (
        <ul aria-label="Sync problems" className="list-disc space-y-0.5 pl-5 text-xs text-port-warning">
          {manifest.problems.map((problem) => <li key={problem} className="break-words">{problem}</li>)}
        </ul>
      )}
    </div>
  );
}
