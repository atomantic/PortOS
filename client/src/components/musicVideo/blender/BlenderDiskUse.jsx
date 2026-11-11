import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import toast from '../../ui/Toast';
import InlineConfirmRow from '../../ui/InlineConfirmRow';
import { getMusicVideoBlenderUsage } from '../../../services/apiMusicVideo.js';
import { isBlenderJobActive } from '../../../lib/musicVideoBlender.js';
import { formatBytes, formatCount } from '../../../utils/formatters.js';
import { buttonCls } from './blenderStyles.js';

/**
 * What the film's workspace takes on disk, and "Clear rendered frames": the
 * frames of finished renders are the bulk of it (a long film's final frames
 * run to many gigabytes) and nothing in PortOS reads them once a shot's video
 * is encoded. Clearing keeps every video, still, cut and log, and the frames
 * of unfinished renders (they resume). Read when the tab opens and again when
 * a job ends or frames are cleared (`blender.usageRevision`); never on a timer.
 */
export default function BlenderDiskUse({ blender }) {
  const { projectId, usageRevision, pending, state } = blender;
  const [usage, setUsage] = useState({ status: 'loading', value: null, error: null });
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    let active = true;
    // A refresh keeps the last numbers on screen while the new ones load.
    setUsage((current) => ({ ...current, status: 'loading', error: null }));
    getMusicVideoBlenderUsage(projectId, { silent: true })
      .then((value) => { if (active) setUsage({ status: 'ready', value, error: null }); })
      .catch((err) => { if (active) setUsage((current) => ({ ...current, status: 'error', error: err?.message || 'Could not measure the workspace' })); });
    return () => { active = false; };
  }, [projectId, usageRevision]);

  const value = usage.value;
  const rendering = (state.jobs || []).some((job) => job.kind === 'render' && isBlenderJobActive(job));
  const clearing = !!pending['frames:clear'];
  const removed = value?.removedShots?.length || 0;
  const clear = async () => {
    setConfirming(false);
    const result = await blender.clearFrames();
    if (!result.ok) return;
    if (result.answer?.usage) setUsage({ status: 'ready', value: result.answer.usage, error: null });
    toast.success(`Cleared ${formatBytes(result.answer?.freedBytes ?? 0)} of rendered frames`);
  };

  return (
    <section aria-label="Disk use" className="min-w-0 space-y-1.5">
      <h4 className="text-sm font-medium">Disk use</h4>
      {!value && usage.status === 'loading' && <p role="status" className="text-xs text-port-text-muted">Measuring the workspace…</p>}
      {usage.error && <p role="alert" className="text-xs text-port-error">{usage.error}</p>}
      {value && (
        <>
          <p className="text-xs text-port-text-muted">
            Renders take {formatBytes(value.rendersBytes)}, of which {formatBytes(value.frameBytes)} is {formatCount(value.frameFiles)} rendered{' '}
            {value.frameFiles === 1 ? 'frame' : 'frames'}. The film&apos;s scripts take {formatBytes(value.sourceBytes)}.
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-port-text-muted">
            <button type="button" className={buttonCls} disabled={!(value.clearableBytes > 0) || rendering || clearing || confirming} onClick={() => setConfirming(true)}>
              <Trash2 size={14} aria-hidden="true" /> {clearing ? 'Clearing…' : `Clear rendered frames (${formatBytes(value.clearableBytes)})`}
            </button>
            {rendering
              ? <span role="status" className="text-port-warning">Wait for the renders to finish, or cancel them, before clearing frames.</span>
              : <span className="min-w-0">Frames are only needed until a shot&apos;s video is encoded. Unfinished renders keep theirs so they can resume.</span>}
          </div>
          {confirming && (
            <InlineConfirmRow
              tone="warning"
              aria-label="Confirm clearing rendered frames"
              question={`Remove ${formatBytes(value.clearableBytes)} of frames from finished renders? Every shot video, still and cut stays.${removed
                ? ` This also removes everything rendered for ${formatCount(removed)} ${removed === 1 ? 'shot' : 'shots'} the film no longer lists.` : ''}`}
              confirmText="Clear frames"
              onConfirm={clear}
              onCancel={() => setConfirming(false)}
            />
          )}
        </>
      )}
    </section>
  );
}
