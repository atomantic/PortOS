import { useCallback, useEffect, useMemo, useState } from 'react';
import { Moon } from 'lucide-react';
import socket from '../../services/socket';
import toast from '../ui/Toast';
import { cancelOvernightRenders, listOvernightRenders, queueOvernightRenders } from '../../services/apiImageVideo.js';
import { shotNumbers } from '../../../../server/lib/musicVideoColdOpen.js';
import { formatCount, formatTimeOfDay } from '../../utils/formatters.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm hover:bg-port-border/40 disabled:opacity-50 pointer-fine:sm:min-h-0';
const STATUS_LABEL = { queued: 'Waiting', running: 'Rendering', completed: 'Done', failed: 'Failed', canceled: 'Canceled' };

/** Local models that take a shot's clip references: LTX 2.5 (References) and FastH3 Omni. */
export const overnightModels = (models = []) => models.filter((model) => model.runtime === 'ltx25' || model.fastvideoFamily === 'fasth3omni');

/** The next moment a "HH:MM" clock time comes round, at or after `after`. */
export function nextClockTime(clock, after = new Date()) {
  const [hours, minutes] = String(clock || '').split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  const at = new Date(after);
  at.setHours(hours, minutes, 0, 0);
  if (at <= after) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * Queue a batch of local reference-conditioned clip renders for chosen shots,
 * held until a start time, and review what each batch made. Each render is the
 * shot card's own Render on that model; takes land on their shots and never
 * replace a selected clip.
 */
export default function OvernightRendersPanel({ project, models }) {
  const choices = useMemo(() => overnightModels(models), [models]);
  const numbers = useMemo(() => shotNumbers(project), [project]);
  const shots = useMemo(() => (project.scenes || []).filter((scene) => scene.referenceImageId), [project.scenes]);
  const nameOf = useCallback((sceneId) => {
    const scene = project.scenes?.find((entry) => entry.sceneId === sceneId);
    return scene?.label || (numbers.get(sceneId) ? `Shot ${numbers.get(sceneId)}` : 'Shot');
  }, [project.scenes, numbers]);
  const [sceneIds, setSceneIds] = useState([]);
  const [modelIds, setModelIds] = useState([]);
  const [start, setStart] = useState('23:00');
  const [stop, setStop] = useState('07:00');
  const [sending, setSending] = useState(false);
  const [batches, setBatches] = useState(null);

  const refresh = useCallback(() => {
    listOvernightRenders(project.id, { silent: true }).then((res) => setBatches(res?.batches || []), () => {});
  }, [project.id]);
  useEffect(() => {
    refresh();
    socket.on('media-jobs:changed', refresh);
    return () => { socket.off('media-jobs:changed', refresh); };
  }, [refresh]);

  const toggle = (list, setList, id) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const queue = () => {
    const startAt = start ? nextClockTime(start) : null;
    const stopBy = stop ? nextClockTime(stop, startAt || new Date()) : null;
    setSending(true);
    queueOvernightRenders({ projectId: project.id, sceneIds, modelIds,
      ...(startAt ? { startAt: startAt.toISOString() } : {}), ...(stopBy ? { stopBy: stopBy.toISOString() } : {}) })
      .then((res) => {
        toast.success(`${formatCount(res.queued.length)} overnight ${res.queued.length === 1 ? 'render' : 'renders'} queued`);
        for (const skip of res.skipped) toast.error(`${nameOf(skip.sceneId)}: ${skip.reason}`);
        setSceneIds([]);
        refresh();
      })
      .catch(() => {})
      .finally(() => setSending(false));
  };
  const cancel = (batchId) => cancelOvernightRenders(batchId).then(refresh, () => {});
  const modelName = (id) => models.find((model) => model.id === id)?.name || id;

  if (!choices.length) {
    return <p className="text-xs text-port-text-muted">Overnight renders use local LTX 2.5 or FastH3 Omni. Install one to queue shots overnight.</p>;
  }
  return (
    <div className="space-y-3 text-sm" aria-label="Overnight renders">
      <div className="flex items-center gap-1 font-medium"><Moon size={14} aria-hidden="true" /> Overnight renders</div>
      <fieldset className="space-y-1">
        <legend className="text-xs text-port-text-muted">Shots ({formatCount(sceneIds.length)} picked)</legend>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={BUTTON} onClick={() => setSceneIds(sceneIds.length === shots.length ? [] : shots.map((s) => s.sceneId))}>
            {sceneIds.length === shots.length ? 'None' : 'All with a start frame'}
          </button>
          {shots.map((scene) => (
            <label key={scene.sceneId} className={`${BUTTON} cursor-pointer`}>
              <input type="checkbox" checked={sceneIds.includes(scene.sceneId)} onChange={() => toggle(sceneIds, setSceneIds, scene.sceneId)} />
              {nameOf(scene.sceneId)}
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-1">
        <legend className="text-xs text-port-text-muted">Models (each sends the shot's clip references)</legend>
        <div className="flex flex-wrap gap-1">
          {choices.map((model) => (
            <label key={model.id} className={`${BUTTON} cursor-pointer`}>
              <input type="checkbox" checked={modelIds.includes(model.id)} onChange={() => toggle(modelIds, setModelIds, model.id)} />
              {model.name}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor="mv-overnight-start" className="text-xs text-port-text-muted">Start at
          <input id="mv-overnight-start" type="time" value={start} onChange={(e) => setStart(e.target.value)}
            className="ml-1 rounded border border-port-border bg-port-bg px-1.5 py-1 text-sm" />
        </label>
        <label htmlFor="mv-overnight-stop" className="text-xs text-port-text-muted">Stop by
          <input id="mv-overnight-stop" type="time" value={stop} onChange={(e) => setStop(e.target.value)}
            className="ml-1 rounded border border-port-border bg-port-bg px-1.5 py-1 text-sm" />
        </label>
        <button type="button" className={`${BUTTON} border-port-accent`} disabled={sending || !sceneIds.length || !modelIds.length} onClick={queue}>
          Queue {formatCount(sceneIds.length * modelIds.length)} {sceneIds.length * modelIds.length === 1 ? 'render' : 'renders'}
        </button>
      </div>
      <p className="text-[11px] text-port-text-muted">Clear a time to start now or run until done. Takes land on their shots and never replace a selected clip.</p>
      {batches?.map((batch) => {
        const live = batch.jobs.some((job) => job.status === 'queued' || job.status === 'running');
        return (
          <div key={batch.batchId} className="space-y-1 rounded border border-port-border p-2">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-port-text-muted">
              <span>Queued {formatTimeOfDay(batch.queuedAt)}{batch.schedule?.startAt ? ` · starts ${formatTimeOfDay(batch.schedule.startAt)}` : ''}{batch.schedule?.stopBy ? ` · stops by ${formatTimeOfDay(batch.schedule.stopBy)}` : ''}</span>
              {live && <button type="button" className={BUTTON} onClick={() => cancel(batch.batchId)}>Cancel batch</button>}
            </div>
            <ul className="space-y-0.5 text-xs">
              {batch.jobs.map((job) => (
                <li key={job.jobId} className="flex flex-wrap gap-x-2">
                  <span className="font-medium">{nameOf(job.sceneId)}</span>
                  <span className="text-port-text-muted">{modelName(job.modelId)}</span>
                  {job.videoHistoryId
                    ? <a className="underline" href={`/data/videos/${encodeURIComponent(job.videoHistoryId)}.mp4`} target="_blank" rel="noreferrer">Play take</a>
                    : <span className={job.status === 'failed' ? 'text-port-error' : 'text-port-text-muted'}>{job.statusMsg || job.error || STATUS_LABEL[job.status] || job.status}</span>}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
