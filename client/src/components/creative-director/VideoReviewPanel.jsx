import ScenePreview from './ScenePreview.jsx';
import { useEffect, useRef, useState } from 'react';
import { getCreativeDirectorVideoReview, submitCreativeDirectorVideoReview } from '../../services/apiCreativeDirector.js';

export default function VideoReviewPanel({ project, onChange }) {
  const [review, setReview] = useState(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reload, setReload] = useState(0);
  const [notes, setNotes] = useState({});
  const [targets, setTargets] = useState({});
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    getCreativeDirectorVideoReview(project.id, { silent: true })
      .then(result => { if (active) setReview(result); })
      .catch(err => { if (active) setError(err.message || 'Could not load production reviews'); });
    return () => { active = false; };
  }, [project.id, project.updatedAt, reload]);

  const act = async (checkpoint, action, rating) => {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    const target = targets[checkpoint.stage] || '';
    const [kind, ...parts] = target.split(':');
    const targetId = parts.join(':');
    const input = { action, stage: checkpoint.stage, revision: checkpoint.revision,
      ...(notes[checkpoint.stage]?.trim() ? { note: notes[checkpoint.stage].trim() } : {}),
      ...(rating ? { rating } : {}),
      ...(action === 'request-revision' && targetId ? { [kind === 'scene' ? 'sceneId' : 'stepId']: targetId } : {}) };
    try {
      setReview(await submitCreativeDirectorVideoReview(project.id, input, { silent: true }));
      onChange?.();
    } catch (err) {
      setError(err.message || 'Could not save the review');
      setReload(value => value + 1);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };

  return <section aria-label="Production reviews" className="border-b border-port-border p-4 space-y-3">
    <h2 className="font-medium">Production reviews</h2>
    <p className="text-sm text-port-text-muted">Approve the displayed revision to continue. If production is paused, resume it from Overview. Script revision requests pause production; Resume writes a revised script for review. Thumbs up or down saves feedback only.</p>
    {error && <div role="alert" className="text-sm text-port-error">{error} <button onClick={() => { setError(''); setReload(value => value + 1); }} className="underline">Refresh reviews</button></div>}
    {!review && !error && <p role="status">Loading reviews…</p>}
    {review && !review.canReview && <p role="status" className="text-sm text-port-warning">Review on the owning install. For a draft without an owner, create a new local draft from its saved settings.</p>}
    <div className="grid gap-3 md:grid-cols-2">
      {(review?.checkpoints || []).map(checkpoint => {
        const disabled = pending || !review.canReview || !checkpoint.ready || !review.artifacts;
        const artifact = checkpoint.stage === 'script-shot-plan' ? { script: review.artifacts?.script, shots: review.artifacts?.shots, steps: review.artifacts?.steps }
          : checkpoint.stage === 'references' ? { references: review.artifacts?.references, startingImageFile: review.artifacts?.startingImageFile, frames: review.artifacts?.shots?.map(({ sceneId, sourceImageFile }) => ({ sceneId, sourceImageFile })) }
          : checkpoint.stage === 'rough-cut' ? review.artifacts?.roughCut : review.artifacts?.finalCut;
        const feedback = (review.feedback || []).filter(entry => entry.stage === checkpoint.stage && entry.revision === checkpoint.revision);
        return <div key={checkpoint.stage} className="rounded border border-port-border p-3 space-y-2">
          <h3 className="text-sm font-medium">{checkpoint.label}</h3>
          <p className="text-xs text-port-text-muted">{checkpoint.status.replaceAll('-', ' ')}{checkpoint.skipReason ? ` · ${checkpoint.skipReason}` : ''}</p>
          {checkpoint.ready && <>
            <p className="text-xs text-port-text-muted">Artifact revision {review.artifacts?.revision ?? 'unknown'} · <span title={checkpoint.revision}>{checkpoint.revision.slice(0, 12)}</span></p>
            {checkpoint.stage === 'script-shot-plan' && <p className="text-sm whitespace-pre-wrap">{typeof review.artifacts?.script === 'string' ? review.artifacts.script : JSON.stringify(review.artifacts?.script)}</p>}
            {artifact?.videoId && <ScenePreview jobId={artifact.videoId} src={artifact.filename ? `/data/videos/${encodeURIComponent(artifact.filename)}` : null} label={`${checkpoint.label} preview`} />}
            <details><summary className="cursor-pointer text-xs">View full saved artifact</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(artifact, null, 2)}</pre></details>
          </>}
          {checkpoint.stale && <p className="text-xs text-port-warning">Previous approval is stale.</p>}
          {feedback.length > 0 && <p className="text-xs text-port-text-muted">Saved feedback: {feedback.at(-1).rating === 'up' ? 'thumbs up' : 'thumbs down'}{feedback.at(-1).note ? ` — ${feedback.at(-1).note}` : ''}</p>}
          {checkpoint.ready && <>
            <label htmlFor={`video-review-${checkpoint.stage}-note`} className="block text-xs">Revision notes for {checkpoint.label}
              <textarea id={`video-review-${checkpoint.stage}-note`} value={notes[checkpoint.stage] || ''} maxLength={5000} onChange={event => setNotes(prev => ({ ...prev, [checkpoint.stage]: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg p-2" />
            </label>
            <label htmlFor={`video-review-${checkpoint.stage}-target`} className="block text-xs">Revision target for {checkpoint.label}
              <select id={`video-review-${checkpoint.stage}-target`} value={targets[checkpoint.stage] || ''} onChange={event => setTargets(prev => ({ ...prev, [checkpoint.stage]: event.target.value }))} className="mt-1 w-full rounded border border-port-border bg-port-bg p-2">
                <option value="">Whole stage</option>
                {(review.artifacts?.shots || []).map(scene => <option key={scene.sceneId} value={`scene:${scene.sceneId}`}>Shot {scene.order + 1}: {scene.intent}</option>)}
                {(review.artifacts?.steps || []).map(step => <option key={step.stepId} value={`step:${step.stepId}`}>Step: {step.stepId}</option>)}
              </select>
            </label>
          </>}
          <div className="flex flex-wrap gap-2 text-xs">
            <button disabled={disabled || checkpoint.status !== 'awaiting-review'} onClick={() => act(checkpoint, 'approve')} className="rounded bg-port-accent px-2 py-1 text-white disabled:opacity-40">Approve {checkpoint.label}</button>
            <button disabled={disabled || !notes[checkpoint.stage]?.trim()} onClick={() => act(checkpoint, 'request-revision')} className="rounded border border-port-border px-2 py-1 disabled:opacity-40">Request revision</button>
            <button disabled={disabled} aria-label={`Thumbs up ${checkpoint.label}`} onClick={() => act(checkpoint, 'feedback', 'up')} className="rounded border border-port-border px-2 py-1 disabled:opacity-40">👍</button>
            <button disabled={disabled} aria-label={`Thumbs down ${checkpoint.label}`} onClick={() => act(checkpoint, 'feedback', 'down')} className="rounded border border-port-border px-2 py-1 disabled:opacity-40">👎</button>
          </div>
        </div>;
      })}
    </div>
  </section>;
}
