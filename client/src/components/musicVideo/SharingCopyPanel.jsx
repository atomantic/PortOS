import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { getMusicVideoSharingCopy, prepareMusicVideoSharingCopy, musicVideoSharingCopyDownloadUrl } from '../../services/apiMusicVideo.js';
import { cancelMediaJob } from '../../services/apiMediaJobs.js';
import useSseJobSlot from '../../hooks/useSseJobSlot.js';
import useAsyncAction from '../../hooks/useAsyncAction.js';
import { formatCount } from '../../utils/formatters.js';

/** Keyed by the exact selected final render in ReviewStage. */
export default function SharingCopyPanel({ projectId }) {
  const [copy, setCopy] = useState(null);
  const [error, setError] = useState(null);
  const [canceling, setCanceling] = useState(false);
  const [loading, setLoading] = useState(true);
  const slot = useSseJobSlot({
    eventsUrl: jobId => `/api/video-gen/${encodeURIComponent(jobId)}/events`,
    cancelRequest: (jobId, options) => {
      setCanceling(true);
      return cancelMediaJob(jobId, options).catch(err => { setCanceling(false); setError(err.message); throw err; });
    },
    onSettled: () => setCanceling(false),
    onComplete: frame => { setCopy(frame.result); setError(null); },
    onErrorFrame: frame => { setError(frame.error || 'Sharing export failed'); },
    lostConnectionMessage: 'Sharing export connection lost — use Check export to reconnect',
    canceledMessage: 'Sharing export cancelled',
  });
  const [check, checking] = useAsyncAction(async () => {
    const state = await getMusicVideoSharingCopy(projectId, { silent: true });
    setCopy(state.copy);
    setError(null);
    if (state.jobId && !slot.active) slot.attach(state.jobId, projectId);
  });
  useEffect(() => {
    let active = true;
    getMusicVideoSharingCopy(projectId, { silent: true }).then(state => {
      if (!active) return;
      setCopy(state.copy);
      if (state.jobId) slot.attach(state.jobId, projectId);
    }).catch(err => { if (active) setError(err.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId]);
  const [prepare, preparing] = useAsyncAction(async () => {
    setError(null);
    const state = await prepareMusicVideoSharingCopy(projectId, { silent: true });
    if (state.copy) setCopy(state.copy);
    else if (state.jobId) slot.attach(state.jobId, projectId);
  });
  const busy = loading || preparing || checking;
  return <div className="mt-3 border-t border-port-border pt-3 space-y-2">
    <p className="text-xs text-port-text-muted">Private sharing copy · H.264 MP4 · up to 720p · under 100 MB (100,000,000 bytes). Full-quality MP4 remains available above.</p>
    {copy && <p className="text-xs text-port-text-muted">{formatCount(copy.width)} × {formatCount(copy.height)} · {formatCount(copy.fps)} fps · {formatCount(copy.bytes)} bytes · under 100 MB</p>}
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {copy ? <a href={musicVideoSharingCopyDownloadUrl(projectId)} download className="min-h-[44px] inline-flex items-center gap-1 rounded border border-port-border bg-port-bg px-3 py-2 text-port-accent"><Download size={14} /> Download sharing copy</a>
        : <button type="button" onClick={prepare} disabled={busy || slot.active} className="min-h-[44px] inline-flex items-center gap-1 rounded border border-port-border bg-port-bg px-3 py-2 disabled:opacity-50">
          {(busy || slot.active) && <Loader2 size={14} className="animate-spin" />}{loading ? 'Checking sharing copy…' : preparing ? 'Preparing sharing copy…' : slot.active ? 'Creating sharing copy…' : 'Prepare sharing copy'}
        </button>}
      {slot.active && <button type="button" onClick={slot.cancel} disabled={canceling} className="min-h-[44px] px-2 text-port-warning">{canceling ? 'Cancelling…' : 'Cancel export'}</button>}
      {!slot.active && <button type="button" onClick={check} disabled={busy} className="min-h-[44px] px-2 text-port-text-muted">Check export</button>}
    </div>
    {slot.active && <p role="status" className="text-xs text-port-text-muted">{slot.latest?.message || slot.stage || 'Queued or starting sharing export…'}</p>}
    {error && <p role="alert" className="text-xs text-port-error break-words">{error}</p>}
  </div>;
}
