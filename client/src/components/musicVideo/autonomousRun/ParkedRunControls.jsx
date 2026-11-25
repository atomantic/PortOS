import { Pause, Play, X } from 'lucide-react';
import { VideoModelField } from '../ToolPicker.jsx';
import SongLinkField from './SongLinkField.jsx';
import { buttonClass } from '../controlClasses.js';

export default function ParkedRunControls({ run, auto, resume, videoTools, videoDraft, song, canAct, canRetry, awaiting, reopenable }) {
  const { value: videoSwaps, setValue: setVideoSwaps } = videoDraft;
  // A failed run that only has the final render left retries just that.
  const retryLabel = run.status === 'failed' && run.stage === 'produce' && (run.output?.renderJobId || run.output?.productionDone) ? 'Retry render' : run.status === 'failed' ? 'Retry' : 'Resume';

  // Carry the changes into the same production run when it resumes.
  const resumeParkedRun = () => {
    const models = Object.fromEntries(Object.entries(videoSwaps)
      .filter(([tool, id]) => id !== (run.brief?.models?.[tool] || ''))
      .map(([tool, id]) => [tool, id || null]));
    return resume(videoTools.length && Object.keys(models).length ? { models } : {});
  };

  return (
    <>
      {videoTools.length > 0 && (
        <fieldset aria-label="Swap the video model" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
          {videoTools.map((tool) => (
            <VideoModelField
              key={tool.id}
              id={`mv-run-video-model-${tool.id}`}
              tool={tool}
              value={tool.id in videoSwaps ? videoSwaps[tool.id] : run.brief?.models?.[tool.id] || ''}
              onChange={(value) => setVideoSwaps({ ...videoSwaps, [tool.id]: value })}
            />
          ))}
        </fieldset>
      )}

      {song.canAdopt && (
        <div className="rounded border border-port-border p-2 space-y-2">
          <SongLinkField song={song} />
          <button type="button" disabled={auto.busy || !song.linkedId} onClick={() => resume({ sunoSongId: song.linkedId })} className={buttonClass}>
            Use this Suno song
          </button>
        </div>
      )}

      {canAct && (
        <div className="flex flex-wrap gap-2">
          {canRetry && !awaiting && (
            <button type="button" disabled={auto.busy} onClick={resumeParkedRun} className={buttonClass}>
              <Play size={14} aria-hidden="true" /> {retryLabel}
            </button>
          )}
          {run.status === 'running' && !run.interrupted && (
            <button type="button" disabled={auto.busy} onClick={() => auto.stop()} className={buttonClass}><Pause size={14} aria-hidden="true" /> Pause</button>
          )}
          {!reopenable && <button type="button" disabled={auto.busy} onClick={() => auto.cancel()} className={`${buttonClass} text-port-error`}><X size={14} aria-hidden="true" /> Cancel</button>}
        </div>
      )}
    </>
  );
}
