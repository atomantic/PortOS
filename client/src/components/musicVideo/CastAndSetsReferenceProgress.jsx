import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { formatCount } from '../../utils/formatters';

const imageSource = ({ kind, filename }) => `/data/${kind === 'image-ref' ? 'image-refs' : 'images'}/${encodeURIComponent(filename)}`;

function ReferenceCard({ item, stage }) {
  const image = stage.images?.[item.key] || {};
  // Old images remain visible during regeneration, but only a persisted done
  // record can bypass the new job's subscription.
  const live = useMediaJobProgress(image.status === 'queued' ? image.jobId : null);
  const finishing = image.status === 'queued' && live.status === 'completed';
  const completedFilename = finishing ? live.filename : null;
  const filename = completedFilename || image.imageId;
  const previous = !!filename && image.status !== 'done' && !completedFilename;
  const currentImage = live.status === 'running' && typeof live.currentImage === 'string' && live.currentImage.startsWith('data:image/') ? live.currentImage : null;
  const retained = image.status === 'done' && image.submittedRevision < stage.revision;
  const waiting = (item.deps || []).filter((key) => stage.images?.[key]?.status !== 'done')
    .map((key) => stage.plan?.[key]?.label || key);
  const error = image.error || (image.status === 'queued' ? live.error : null);
  let status = 'Waiting';
  if (image.status === 'done') status = 'Complete';
  else if (image.status === 'failed' || live.status === 'failed') status = 'Failed';
  else if (live.status === 'canceled') status = 'Canceled';
  else if (finishing) status = 'Saving result';
  else if (live.status === 'running') status = 'Rendering';
  else if (stage.interrupted) status = 'Interrupted';
  else if (image.status === 'queued') status = image.jobId ? 'Queued' : 'Preparing';
  else if (stage.status === 'failed') status = 'Waiting for resume';
  else if (error) status = 'Waiting to retry';
  else if (waiting.length) status = `Waiting for ${waiting.join(', ')}`;

  const submitted = typeof image.submittedPrompt === 'string';
  const plannedReferences = [
    ...(item.refKeys || []).flatMap((key) => stage.images?.[key]?.imageId
      ? [{ kind: 'image', filename: stage.images[key].imageId }] : []),
    ...(item.moodRefs ? stage.moodImages || [] : []),
  ];
  const references = submitted ? image.submittedReferences || [] : plannedReferences;
  const src = filename ? imageSource({ kind: 'image', filename }) : null;
  return (
    <article className="min-w-0 rounded border border-port-border bg-port-bg p-2 space-y-2" aria-label={item.label || item.key}>
      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-1">
        <h4 className="text-xs font-medium break-words [overflow-wrap:anywhere]">{item.label || item.key}</h4>
        <span className="text-[11px] text-port-text-muted break-words" role="status">{status}</span>
      </div>
      {currentImage && <figure className="space-y-1">
        <img src={currentImage} alt={`${item.label || item.key} — in-progress render`} className="w-full max-h-64 rounded object-contain" />
        <figcaption className="text-[11px] text-port-text-muted">In-progress preview</figcaption>
      </figure>}
      {src && (
        <figure className="space-y-1">
          <a href={src} target="_blank" rel="noreferrer" className="block rounded focus-visible:outline focus-visible:outline-port-accent">
            <img src={src} alt={`${item.label || item.key} — ${previous ? 'previous revision' : 'generated reference'}`}
              className={`w-full ${currentImage ? 'max-h-24' : 'max-h-64'} rounded object-contain`} loading="lazy" />
          </a>
          {(previous || retained) && <figcaption className="text-[11px] text-port-text-muted">{previous ? 'Previous revision — replacement pending' : `Retained from revision ${formatCount(image.submittedRevision)}`}</figcaption>}
        </figure>
      )}
      {error && <p role="alert" className="text-xs text-port-error break-words [overflow-wrap:anywhere]">{error}</p>}
      {live.status === 'running' && <progress aria-label={`${item.label || item.key} rendering progress`} className="w-full" max={1} value={Math.max(0, Math.min(1, live.progress || 0))} />}
      {live.status === 'running' && live.statusMsg && <p className="text-[11px] text-port-text-muted break-words">{live.statusMsg}</p>}
      <details className="min-w-0 text-xs">
        <summary className="cursor-pointer min-h-[44px] sm:min-h-0 py-1 text-port-accent">{submitted ? 'Submitted prompt' : 'Planned prompt'}</summary>
        {!submitted && <p className="text-[11px] text-port-text-muted">The submitted prompt has not been recorded. Style instructions may be added when queued.</p>}
        <p className="mt-1 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{submitted ? image.submittedPrompt : item.prompt || 'No planned prompt recorded.'}</p>
        {image.submittedPromptTruncated && <p className="mt-1 text-port-warning">The recorded prompt is truncated.</p>}
        {image.submittedReferencesTruncated && <p className="mt-1 text-port-warning">Only the first {formatCount(16)} image inputs are recorded.</p>}
        {references.length > 0 && (
          <div className="mt-2 space-y-1">
            <p className="text-port-text-muted">{submitted ? 'Submitted image inputs' : 'Planned image inputs'}</p>
            <div className="flex flex-wrap gap-2">
              {references.map((ref, index) => (
                <a key={`${ref.kind}:${ref.filename}:${index}`} href={imageSource(ref)} target="_blank" rel="noreferrer"
                  className="min-w-0 w-16 rounded focus-visible:outline focus-visible:outline-port-accent" title={ref.filename}>
                  <img src={imageSource(ref)} alt={`${item.label || item.key} input: ${ref.filename}`} className="h-16 w-16 rounded object-contain" loading="lazy" />
                </a>
              ))}
            </div>
          </div>
        )}
      </details>
    </article>
  );
}

export default function CastAndSetsReferenceProgress({ stage }) {
  const items = Object.values(stage.plan || {});
  if (!items.length) return null;
  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2" aria-label="Cast and set references">
      {items.map((item) => <ReferenceCard key={item.key} item={item} stage={stage} />)}
    </div>
  );
}
