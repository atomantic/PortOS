/**
 * VoiceFineTuningPanel — the Voice Lab's Fine-Tuning tab (#10400).
 *
 * Starts a Qwen3-TTS fine-tune for one voice profile, then shows each run's
 * live status and sealed checkpoints with their audition samples, cancels a
 * running job, and promotes a verified checkpoint to the character's voice.
 *
 * Runs load once from the profile's job sidecars (so a reload recovers them)
 * and then update from `voice:fine-tune:updated` frames, which carry the whole
 * job — no timer, no refetch per frame. A reconnect or tab re-show reconciles
 * against the list through `useSocketResource`.
 */

import { useRef, useState } from 'react';
import { Activity, BadgeCheck, Loader2, Square } from 'lucide-react';
import useAsyncAction from '../../hooks/useAsyncAction';
import { useSocketResource } from '../../hooks/useSocketResource';
import {
  cancelFineTuningJob,
  listFineTuningJobs,
  promoteFineTunedCheckpoint,
  startFineTuningJob,
} from '../../services/apiVoice';
import { formatCount, formatPercent, timeAgo } from '../../utils/formatters';

const FINE_TUNE_EVENTS = ['voice:fine-tune:updated'];

const STATUS_CLASS = {
  running: 'text-port-accent',
  completed: 'text-port-success',
  failed: 'text-port-error',
  interrupted: 'text-port-warning',
  cancelled: 'text-gray-400',
};

const byNewest = (a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || ''));
const upsertJob = (jobs, job) => [job, ...jobs.filter((existing) => existing.id !== job.id)].sort(byNewest);

function CheckpointRow({ job, checkpoint, active, disabled, promoting, error, onPromote }) {
  const label = `Step ${formatCount(checkpoint.step)}`;
  const blocked = !checkpoint.promotable;
  return (
    <li className="flex flex-col gap-1 rounded border border-port-border/30 p-1.5 sm:flex-row sm:items-center sm:gap-2">
      <div className="flex min-w-0 items-center gap-2 text-[10px] sm:w-32 sm:shrink-0">
        <span className="font-medium text-gray-300">{label}</span>
        {Number.isFinite(checkpoint.loss) ? <span className="text-gray-500">loss {checkpoint.loss.toFixed(3)}</span> : null}
      </div>
      {checkpoint.auditionUrl ? (
        <audio
          controls
          preload="none"
          src={checkpoint.auditionUrl}
          aria-label={`Audition for ${label}`}
          className="h-8 w-full min-w-0 sm:flex-1"
        >
          <track kind="captions" />
        </audio>
      ) : (
        <span className="text-[10px] text-gray-500 sm:flex-1">No audition sample</span>
      )}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 sm:shrink-0 sm:justify-end">
        {active ? (
          <span className="inline-flex items-center gap-1 text-[10px] font-medium text-port-success">
            <BadgeCheck size={10} /> Active voice
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onPromote(job, checkpoint)}
            disabled={disabled || blocked || promoting}
            aria-label={`Promote ${label}`}
            className="inline-flex min-h-8 items-center gap-1 rounded bg-port-accent/20 px-2 py-0.5 text-[10px] text-port-accent hover:bg-port-accent hover:text-white disabled:opacity-40 disabled:hover:bg-port-accent/20 disabled:hover:text-port-accent"
          >
            {promoting ? <Loader2 size={10} className="animate-spin" /> : <BadgeCheck size={10} />} Promote
          </button>
        )}
        {blocked || error ? (
          <span role="note" className="min-w-0 break-words text-[10px] text-port-warning">
            {error || checkpoint.promotionBlockedReason}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function JobCard({ job, activeModelRevision, disabled, cancelling, onCancel, promotingKey, promoteErrors, onPromote }) {
  const running = job.status === 'running';
  const progress = Number.isFinite(job.progress) ? Math.max(0, Math.min(100, job.progress)) : 0;
  return (
    <div className="space-y-1.5 rounded border border-port-border/40 bg-port-bg/40 p-2 text-[10px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="min-w-0 text-gray-400">
          <span className={`font-semibold capitalize ${STATUS_CLASS[job.status] || 'text-gray-300'}`}>{job.status}</span>
          {' · '}started {timeAgo(job.startedAt, 'unknown')}
          {job.step ? <> · step {formatCount(job.step)}{job.totalSteps ? ` / ${formatCount(job.totalSteps)}` : ''}</> : null}
          {Number.isFinite(job.loss) ? <> · loss {job.loss.toFixed(3)}</> : null}
        </p>
        {running ? (
          <button
            type="button"
            onClick={() => onCancel(job.id)}
            disabled={disabled || cancelling}
            className="inline-flex min-h-8 items-center gap-1 rounded border border-port-error/60 px-2 py-0.5 text-[10px] text-port-error hover:bg-port-error hover:text-white disabled:opacity-40"
          >
            {cancelling ? <Loader2 size={10} className="animate-spin" /> : <Square size={10} />} Cancel
          </button>
        ) : null}
      </div>
      {running ? (
        <div
          role="progressbar"
          aria-label="Fine-tuning progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
          className="h-1.5 overflow-hidden rounded bg-port-border/40"
        >
          <div className="h-full bg-port-accent transition-all" style={{ width: `${progress}%` }} />
        </div>
      ) : null}
      {running ? <p className="text-gray-500">{formatPercent(progress, { decimals: 0 })} · checkpoints appear here as they are sealed and auditioned.</p> : null}
      {job.error && job.status !== 'running' ? <p className="break-words text-port-error">{job.error}</p> : null}
      {job.checkpoints?.length ? (
        <ul className="space-y-1" aria-label="Checkpoints">
          {job.checkpoints.map((checkpoint) => {
            const key = `${job.id}:${checkpoint.id}`;
            return (
              <CheckpointRow
                key={key}
                job={job}
                checkpoint={checkpoint}
                active={Boolean(activeModelRevision) && checkpoint.modelRevision === activeModelRevision}
                disabled={disabled}
                promoting={promotingKey === key}
                error={promoteErrors[key]}
                onPromote={onPromote}
              />
            );
          })}
        </ul>
      ) : (
        !running && <p className="text-gray-500">This run produced no checkpoints.</p>
      )}
    </div>
  );
}

export default function VoiceFineTuningPanel({ profileId, disabled, activeModelRevision = null, onPromoted }) {
  const [epochs, setEpochs] = useState(5);
  const [promotingKey, setPromotingKey] = useState(null);
  const [promoteErrors, setPromoteErrors] = useState({});
  // The list the last read produced, keyed by profile, so event frames merge
  // onto it without a network round-trip.
  const jobsRef = useRef({ key: null, jobs: null });

  const { data: jobs, loading, error, refetch, updateData } = useSocketResource(async ({ reconcile, events, signal }) => {
    let list = jobsRef.current.key === profileId ? jobsRef.current.jobs : null;
    if (reconcile || !list) list = (await listFineTuningJobs(profileId, { signal, silent: true }))?.jobs ?? [];
    for (const { payload } of events) list = upsertJob(list, payload.job);
    jobsRef.current = { key: profileId, jobs: list };
    return list;
  }, {
    events: FINE_TUNE_EVENTS,
    resourceKey: profileId || null,
    enabled: Boolean(profileId),
    matchesEvent: (payload) => payload?.profileId === profileId && Boolean(payload.job?.id),
  });

  // Apply a mutation's own response at once. Before the first list lands there
  // is nothing to merge onto, so read instead of replacing it with one job.
  const applyJob = (job) => {
    const current = jobsRef.current.key === profileId ? jobsRef.current.jobs : null;
    if (!job || !current) {
      refetch();
      return;
    }
    const next = upsertJob(current, job);
    jobsRef.current = { key: profileId, jobs: next };
    updateData(next);
  };

  const [start, starting] = useAsyncAction(async () => {
    const result = await startFineTuningJob(profileId, { epochs }, { silent: true });
    applyJob(result?.job);
    return result;
  }, { errorMessage: 'Failed to start fine-tuning' });

  const [cancel, cancelling] = useAsyncAction(async (jobId) => {
    const result = await cancelFineTuningJob(profileId, jobId, { silent: true });
    applyJob(result?.job);
    return result;
  }, { errorMessage: 'Failed to cancel fine-tuning' });

  // The refusal reason belongs beside the checkpoint it refused, so the error
  // renders inline rather than as a toast.
  const promote = async (job, checkpoint) => {
    const key = `${job.id}:${checkpoint.id}`;
    setPromotingKey(key);
    const result = await promoteFineTunedCheckpoint(profileId, job.id, checkpoint.id, { silent: true })
      .catch((err) => {
        setPromoteErrors((prev) => ({ ...prev, [key]: err?.message || 'Could not promote checkpoint' }));
        return null;
      });
    setPromotingKey(null);
    if (!result) return;
    setPromoteErrors(({ [key]: _cleared, ...rest }) => rest);
    await onPromoted?.(result.profile);
  };

  const anyRunning = Boolean(jobs?.some((job) => job.status === 'running'));
  const epochsId = `fine-tune-epochs-${profileId || 'none'}`;

  return (
    <div className="space-y-2">
      <p className="text-[10px] text-gray-400">
        Optional character voice fine-tuning. Requires a supported Qwen training adapter; without one the request is refused and no checkpoint is created.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="w-24">
          <label htmlFor={epochsId} className="block text-[10px] text-gray-400">Epochs</label>
          <input
            id={epochsId}
            type="number"
            value={epochs}
            onChange={(e) => setEpochs(parseInt(e.target.value, 10) || 5)}
            min="1"
            max="20"
            className="mt-0.5 w-full rounded border border-port-border bg-port-bg px-2 py-1 text-xs text-white"
          />
        </div>
        <button
          type="button"
          onClick={start}
          disabled={disabled || starting || !profileId || anyRunning}
          title={anyRunning ? 'A fine-tuning run is already in progress for this voice' : undefined}
          className="inline-flex min-h-8 items-center gap-1 rounded bg-port-accent px-2 py-1 text-xs text-white hover:bg-port-accent/80 disabled:opacity-40"
        >
          {starting ? <Loader2 size={12} className="animate-spin" /> : <Activity size={12} />}
          Start Fine-Tuning Job
        </button>
      </div>
      {!profileId ? <p className="text-[10px] text-gray-500">Create or promote a voice profile before fine-tuning.</p> : null}
      {profileId && loading && !jobs ? (
        <p className="inline-flex items-center gap-1 text-[10px] text-gray-500"><Loader2 size={10} className="animate-spin" /> Loading runs…</p>
      ) : null}
      {error && !jobs ? <p className="text-[10px] text-port-error">Could not load fine-tuning runs: {error.message}</p> : null}
      {jobs?.length ? (
        <div className="space-y-1.5">
          {jobs.map((job) => (
            <JobCard
              key={job.id}
              job={job}
              activeModelRevision={activeModelRevision}
              disabled={disabled}
              cancelling={cancelling}
              onCancel={cancel}
              promotingKey={promotingKey}
              promoteErrors={promoteErrors}
              onPromote={promote}
            />
          ))}
        </div>
      ) : null}
      {jobs && !jobs.length ? <p className="text-[10px] text-gray-500">No fine-tuning runs for this voice yet.</p> : null}
    </div>
  );
}
