import { castSetsInspectionInputs, currentCastSetsInspection, castSetsImageAccepted } from '../../../../server/lib/musicVideoCastSetsInspection.js';
import { Link, useLocation } from 'react-router';
import { Wand2 } from 'lucide-react';
import useMediaJobProgress from '../../hooks/useMediaJobProgress';
import { detailTabPath, libraryById } from '../../lib/creativeLibraries';
import { formatCount } from '../../utils/formatters';
import { normalizeImage } from '../media/normalize.js';
import CastAndSetsItemActions from './CastAndSetsItemActions.jsx';

const imageSource = ({ kind, filename }) => `/data/${kind === 'image-ref' ? 'image-refs' : 'images'}/${encodeURIComponent(filename)}`;
// Reference sheets live under /data/image-refs, so they get their own key
// prefix and can't collide with a same-named gallery image (usePreviewRoute).
export const castAndSetsPreviewKey = ({ kind, filename }) => `${kind === 'image-ref' ? 'image-ref' : 'image'}:${filename}`;

function previewItem(ref, prompt) {
  const item = normalizeImage({ filename: ref.filename, path: imageSource(ref), prompt });
  return ref.kind === 'image-ref' ? { ...item, key: castAndSetsPreviewKey(ref) } : item;
}

// Submitted inputs once the job is recorded, else what the plan will send.
function cardReferences(item, stage) {
  const image = stage.images?.[item.key] || {};
  if (typeof image.submittedPrompt === 'string') return image.submittedReferences || [];
  return [
    ...(item.refKeys || []).flatMap((key) => stage.images?.[key]?.imageId
      ? [{ kind: 'image', filename: stage.images[key].imageId }] : []),
    ...(item.refImages || []).map((filename) => ({ kind: 'image', filename })),
  ];
}

/**
 * Lightbox items for every image the check-in shows: each generated reference
 * and the inputs it was (or will be) conditioned on. Taps open these in the
 * page's MediaPreview instead of navigating to the raw file, which strands a
 * Home Screen app with no back control.
 */
export function castAndSetsPreviewItems(stage) {
  if (!stage) return [];
  const items = [];
  for (const item of Object.values(stage.plan || {})) {
    const image = stage.images?.[item.key] || {};
    const label = item.label || item.key;
    if (image.imageId) items.push(previewItem({ kind: 'image', filename: image.imageId }, image.submittedPrompt || item.prompt || label));
    for (const ref of cardReferences(item, stage)) if (ref?.filename) items.push(previewItem(ref, `${label} input`));
  }
  return items;
}

// The Casting record a character card was built from, matched the way the
// server's plan matches subjects: by form subject, protagonist or cast name.
function castingIdFor(item, stage, subjects) {
  const characters = subjects.filter((s) => s?.kind === 'character' && s.ingredientId);
  const subject = item.kind === 'form' ? characters.find((s) => s.id === item.subjectId)
    : item.kind === 'cast' ? characters.find((s) => s.name === item.label)
    : item.kind === 'character' ? characters.find((s) => s.role === 'protagonist')
      || characters.find((s) => s.name === stage.direction?.protagonist?.name)
    : null;
  return subject?.ingredientId || null;
}

function ReviseLookLink({ ingredientId }) {
  const { pathname, search } = useLocation();
  const to = `${detailTabPath(libraryById('casting'), ingredientId, 'design')}?${new URLSearchParams({ returnTo: `${pathname}${search}` })}`;
  return <Link to={to} className="inline-flex min-h-11 items-center gap-1 text-xs text-port-accent">
    <Wand2 size={12} aria-hidden="true" /> Revise look</Link>;
}

function ReferenceCard({ item, stage, onOpenPreview, actions, subjects, olderLook, onAcknowledgeImage, busy }) {
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

  const inspection = currentCastSetsInspection(stage, item.key);
  const accepted = castSetsImageAccepted(stage, item.key);
  const submitted = typeof image.submittedPrompt === 'string';
  const references = cardReferences(item, stage);
  const castingId = castingIdFor(item, stage, subjects);
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
          <button type="button" onClick={() => onOpenPreview?.(castAndSetsPreviewKey({ kind: 'image', filename }))}
            aria-label={`Preview ${item.label || item.key}`} className="block w-full rounded focus-visible:outline focus-visible:outline-port-accent">
            <img src={src} alt={`${item.label || item.key} — ${previous ? 'previous revision' : 'generated reference'}`}
              className={`w-full ${currentImage ? 'max-h-24' : 'max-h-64'} rounded object-contain`} loading="lazy" />
          </button>
          {(previous || retained) && <figcaption className="text-[11px] text-port-text-muted">{previous ? 'Previous revision — replacement pending' : `Retained from revision ${formatCount(image.submittedRevision)}`}</figcaption>}
        </figure>
      )}
      {image.status === 'done' && (
        <div className="rounded border border-port-border p-2 text-xs space-y-1" role="status">
          <p className={inspection?.verdict === 'pass' ? 'text-port-success' : 'text-port-warning'}>
            {inspection?.verdict === 'pass' ? 'Vision: matches saved prompt' : inspection?.verdict === 'mismatch' ? (inspection.checks?.some((c) => c.id === 'render-quality' && c.status === 'fail') ? 'Vision: rendering defect' : 'Vision: prompt mismatch') : inspection?.verdict === 'pending' ? 'Vision: inspecting image…' : 'Vision: unreviewed'}
          </p>
          {inspection?.discrepancy && <p className="break-words">{inspection.discrepancy}</p>}
          {accepted && inspection?.verdict !== 'pass' && <p>Explicitly acknowledged for this image.</p>}
          {!accepted && stage.status === 'review' && onAcknowledgeImage && (
            <button type="button" disabled={busy} className="min-h-[44px] rounded border border-port-border px-2 text-port-accent"
              onClick={() => onAcknowledgeImage({ inputs: castSetsInspectionInputs(stage, item.key), inspectionId: inspection?.id || null })}>
              Acknowledge {inspection?.verdict === 'mismatch' ? 'mismatch' : 'unreviewed image'}
            </button>
          )}
        </div>
      )}
      {olderLook && <p className="text-[11px] text-port-warning">Older look: Casting changed since this was rendered. Regenerate to use the new look.</p>}
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
                <button type="button" key={`${ref.kind}:${ref.filename}:${index}`} onClick={() => onOpenPreview?.(castAndSetsPreviewKey(ref))}
                  className="min-w-0 w-16 rounded focus-visible:outline focus-visible:outline-port-accent" title={ref.filename}>
                  <img src={imageSource(ref)} alt={`${item.label || item.key} input: ${ref.filename}`} className="h-16 w-16 rounded object-contain" loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        )}
      </details>
      {castingId && <ReviseLookLink ingredientId={castingId} />}
      {actions && <CastAndSetsItemActions key={actions.projectId} item={item} direction={stage.direction} revision={stage.revision} {...actions} />}
    </article>
  );
}

/**
 * `actions` ({ busy, onRegenerate, onEdit }) adds each card's Regenerate / Edit /
 * Remove; the check-in passes it only while the stage is idle.
 */
export default function CastAndSetsReferenceProgress({ stage, onOpenPreview, actions = null, subjects = [], olderLookKeys = [], onAcknowledgeImage, busy }) {
  const items = Object.values(stage.plan || {});
  if (!items.length) return null;
  return (
    <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-2" aria-label="Cast and set references">
      {items.map((item) => <ReferenceCard key={item.key} item={item} stage={stage} onOpenPreview={onOpenPreview} actions={actions}
        subjects={subjects} olderLook={olderLookKeys.includes(item.key)} onAcknowledgeImage={onAcknowledgeImage} busy={busy} />)}
    </div>
  );
}
