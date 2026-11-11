import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import { RefreshCw, ScrollText, Square } from 'lucide-react';
import Pill from '../../ui/Pill';
import ProgressBar from '../../ui/ProgressBar';
import { useTimeTick } from '../../../hooks/useTimeTick.js';
import {
  BLENDER_JOB_PARAM, BLENDER_JOB_STATUS_LABELS, blenderJobPercent, blenderJobTitle, isBlenderJobActive, sortBlenderJobs,
} from '../../../lib/musicVideoBlender.js';
import { getMusicVideoBlenderLog } from '../../../services/apiMusicVideo.js';
import { formatCount, formatDurationMs } from '../../../utils/formatters.js';
import { buttonCls } from './blenderStyles.js';

export { BLENDER_JOB_PARAM };
const STATUS_TONES = { queued: 'muted', running: 'accent', encoding: 'accent', done: 'success', error: 'error', canceled: 'warning' };

// A running job's clock ticks once a second; a finished one shows how long it took.
function JobElapsed({ job }) {
  const active = isBlenderJobActive(job) && job.status !== 'queued';
  const now = useTimeTick(1000, { enabled: active });
  const started = Date.parse(job.startedAt || '');
  if (!Number.isFinite(started) || job.status === 'queued') return null;
  const end = active ? now : Date.parse(job.finishedAt || '');
  if (!Number.isFinite(end)) return null;
  return <span>{formatDurationMs(Math.max(0, end - started))}</span>;
}

// The job's log file, read through the media route. Re-read when the job changes state and on Refresh; never on a timer.
function JobLog({ projectId, job }) {
  const [log, setLog] = useState({ text: '', status: 'loading', error: null });
  const [reload, setReload] = useState(0);
  const { id, logFile, status } = job;
  useEffect(() => {
    if (!logFile) {
      setLog({ text: '', status: 'none', error: null });
      return undefined;
    }
    let active = true;
    setLog((current) => ({ ...current, status: 'loading', error: null }));
    getMusicVideoBlenderLog(projectId, logFile, { silent: true })
      .then((text) => { if (active) setLog({ text: typeof text === 'string' ? text : '', status: 'ready', error: null }); })
      .catch((err) => { if (active) setLog({ text: '', status: 'error', error: err?.message || 'Could not read the log' }); });
    return () => { active = false; };
  }, [projectId, id, logFile, status, reload]);

  return (
    <section aria-label={`Log of ${blenderJobTitle(job)}`} className="min-w-0 space-y-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <h4 className="min-w-0 flex-1 break-words text-sm font-medium">Log · {blenderJobTitle(job)}</h4>
        {logFile && (
          <button type="button" className={buttonCls} disabled={log.status === 'loading'} onClick={() => setReload((count) => count + 1)}>
            <RefreshCw size={14} aria-hidden="true" className={log.status === 'loading' ? 'animate-spin' : ''} /> Refresh log
          </button>
        )}
      </div>
      {log.status === 'none' && <p className="text-xs text-port-text-muted">This job has no log file yet.</p>}
      {log.status === 'error' && <p role="alert" className="text-xs text-port-error">{log.error}</p>}
      {log.status === 'loading' && !log.text && <p role="status" className="text-xs text-port-text-muted">Loading the log…</p>}
      {log.text && (
        <pre tabIndex={0} aria-label="Job log text" className="max-h-[50dvh] min-w-0 overflow-auto whitespace-pre-wrap break-words rounded border border-port-border bg-port-bg p-2 font-mono text-[11px] leading-4">
          {log.text}
        </pre>
      )}
      {log.status === 'ready' && !log.text && <p className="text-xs text-port-text-muted">The log is empty.</p>}
    </section>
  );
}

/**
 * Blender jobs for this film: the ones at work and waiting, then recently
 * finished ones, each with its progress, seconds per frame and time taken, a
 * Cancel while it can still be stopped, and its log. The job whose log is
 * open is `?bjob=<jobId>`. Jobs live in the server's memory: a restart
 * clears the list, and finished frames stay on disk.
 */
export default function BlenderJobsTab({ blender }) {
  const { state, pending, projectId } = blender;
  const [searchParams, setSearchParams] = useSearchParams();
  const jobs = sortBlenderJobs(state.jobs);
  const requested = searchParams.get(BLENDER_JOB_PARAM);
  const selected = jobs.find((job) => job.id === requested) || null;
  const active = jobs.filter(isBlenderJobActive).length;
  const select = (id) => setSearchParams((previous) => {
    const next = new URLSearchParams(previous);
    if (id) next.set(BLENDER_JOB_PARAM, id); else next.delete(BLENDER_JOB_PARAM);
    return next;
  }, { replace: true });

  if (!jobs.length) {
    // The list lives in the server's memory, so "none" may only mean "none since it started".
    return (
      <p className="text-xs text-port-text-muted">
        No jobs since PortOS last started. Syncs, shot renders and cuts appear here while they run and after they finish; the logs of
        earlier jobs stay in the workspace under <code className="font-mono">renders/logs</code>.
      </p>
    );
  }
  return (
    <div className="@container min-w-0 space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-port-text-muted">
        <span>{formatCount(active)} running or queued · {formatCount(jobs.length - active)} finished</span>
        {active > 0 && (
          <button type="button" className={buttonCls} disabled={!!pending['cancel:all']} onClick={() => blender.cancelAll()}>
            <Square size={14} aria-hidden="true" /> {pending['cancel:all'] ? 'Canceling…' : 'Cancel all'}
          </button>
        )}
      </div>
      <ul aria-label="Jobs" className="min-w-0 divide-y divide-port-border rounded border border-port-border">
        {jobs.map((job) => {
          const percent = blenderJobPercent(job);
          const working = job.status === 'running' || job.status === 'encoding';
          return (
            <li key={job.id} className={`min-w-0 space-y-1 px-2 py-1.5 ${selected?.id === job.id ? 'bg-port-accent/10' : ''}`}>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <span className="min-w-0 break-words text-sm">{blenderJobTitle(job)}</span>
                <Pill size="xs" tone={STATUS_TONES[job.status] || 'muted'}>{BLENDER_JOB_STATUS_LABELS[job.status] || job.status}</Pill>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 text-port-text-muted">
                  {/* A render counts frames; a cut reports how far its assembly is. */}
                  {job.kind === 'render' && job.total > 0 && Number.isFinite(job.index) && <span>frame {formatCount(job.index)} of {formatCount(job.total)}</span>}
                  {job.kind === 'cut' && working && percent != null && <span>{formatCount(percent)}%</span>}
                  {Number.isFinite(job.secPerFrame) && <span>{job.secPerFrame.toFixed(2)} s/frame</span>}
                  <JobElapsed job={job} />
                </span>
                {isBlenderJobActive(job) && (
                  <button type="button" className={buttonCls} disabled={!!pending[`cancel:${job.id}`]} onClick={() => blender.cancelJob(job.id)}>
                    <Square size={14} aria-hidden="true" /> {pending[`cancel:${job.id}`] ? 'Canceling…' : 'Cancel'}
                  </button>
                )}
                <button type="button" className={buttonCls} aria-pressed={selected?.id === job.id} onClick={() => select(selected?.id === job.id ? null : job.id)}>
                  <ScrollText size={14} aria-hidden="true" /> {selected?.id === job.id ? 'Hide log' : 'View log'}
                </button>
              </div>
              {working && <ProgressBar percent={job.status === 'encoding' ? null : percent} label={`${blenderJobTitle(job)} progress`} />}
              {job.error && <p role="alert" className="break-words text-xs text-port-error">{job.error}</p>}
              {job.problems?.length > 1 && (
                <ul aria-label={`Problems reported by ${blenderJobTitle(job)}`} className="list-disc space-y-0.5 pl-5 text-xs">
                  {job.problems.map((problem) => <li key={problem} className="break-words">{problem}</li>)}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {requested && !selected && <p role="status" className="text-xs text-port-warning">That job is no longer in the list. Its log may still be in the workspace under renders/logs.</p>}
      {selected && <JobLog key={selected.id} projectId={projectId} job={selected} />}
    </div>
  );
}
