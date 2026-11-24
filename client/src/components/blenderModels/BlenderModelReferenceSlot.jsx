import { useCallback, useState } from 'react';
import { Check, ImagePlus, Images, RotateCcw, Trash2 } from 'lucide-react';
import Pill from '../ui/Pill';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import MediaImage from '../MediaImage';
import MediaJobThumb from '../pipeline/MediaJobThumb';
import ModelInputPreview from '../media/ModelInputPreview';
import GalleryImagePicker from '../imageGen/GalleryImagePicker';
import { useModelInputPreview } from '../../hooks/useModelInputPreview';
import { previewBlenderModelReference } from '../../services/apiBlenderModels.js';
import { referenceImageUrls } from '../../lib/blenderModels.js';
import { buttonCls, inputCls, labelCls, primaryCls } from '../musicVideo/blender/blenderStyles.js';

const STATUS = { rendering: ['Rendering', 'accent'], review: ['Review', 'warning'], approved: ['Approved', 'success'], superseded: ['Superseded', 'muted'], failed: ['Failed', 'error'] };

function ReferenceImage({ model, slot, image }) {
  const [redoing, setRedoing] = useState(false);
  const [note, setNote] = useState('');
  const [label, tone] = STATUS[image.status];
  const busy = !!model.pending[`review:${image.id}`];
  const review = async (decision) => {
    const result = await model.reviewReference(slot.id, image.id, { decision, ...(decision === 'redo' && note.trim() ? { note: note.trim() } : {}) });
    if (result.ok) { setRedoing(false); setNote(''); }
  };
  const [src, fallback] = image.filename ? referenceImageUrls(image.filename) : [];
  const [resolvedSrc, setResolvedSrc] = useState(null);
  const href = src && resolvedSrc?.forSrc === src ? resolvedSrc.url : src;
  return (
    <li className="min-w-0 space-y-1.5 rounded border border-port-border p-2">
      {image.filename && (
        <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${image.filename} full size`}>
          <MediaImage
            src={src}
            fallbackSrc={fallback}
            alt={`${label} reference`}
            loading="lazy"
            className="max-h-96 w-full object-contain"
            onLoad={(event) => {
              const loaded = event.currentTarget.getAttribute('src');
              if (loaded) setResolvedSrc({ forSrc: src, url: loaded });
            }}
          />
        </a>
      )}
      {image.status === 'rendering' && image.jobId && <MediaJobThumb jobId={image.jobId} label="Reference image" size="md" />}
      <Pill size="xs" tone={tone}>{label}</Pill>
      {image.error && <p role="status" className="break-words text-xs text-port-error">{image.error}</p>}
      {image.note && <p className="break-words text-xs text-port-text-muted">{image.note}</p>}
      {image.filename && !redoing && (
        <div className="flex flex-wrap gap-1.5">
          {image.status !== 'approved' && (
            <button type="button" className={primaryCls} disabled={busy || slot.locked} onClick={() => review('approve')}><Check size={14} aria-hidden="true" /> Approve</button>
          )}
          {image.status !== 'superseded' && (
            <button type="button" className={buttonCls} disabled={busy} onClick={() => setRedoing(true)}><RotateCcw size={14} aria-hidden="true" /> Redo…</button>
          )}
        </div>
      )}
      {redoing && (
        <form className="space-y-1.5" onSubmit={(event) => { event.preventDefault(); review('redo'); }}>
          <label htmlFor={`bm-note-${image.id}`} className={labelCls}>What should change? (optional, added to your words below)</label>
          <input id={`bm-note-${image.id}`} className={inputCls} value={note} maxLength={2000} onChange={(event) => setNote(event.target.value)} />
          <div className="flex flex-wrap gap-1.5">
            <button type="submit" className={primaryCls} disabled={busy}>Send back</button>
            <button type="button" className={buttonCls} onClick={() => setRedoing(false)}>Cancel</button>
          </div>
        </form>
      )}
    </li>
  );
}

/** One reference to make: the user's words, exactly what would be sent, Render, and the review of each image. */
export default function BlenderModelReferenceSlot({ model, slot, title, hint = null, removable = false }) {
  const { state, pending } = model;
  // null until edited, so a redo note added by the review shows in the box.
  const [draft, setDraft] = useState(null);
  const [picking, setPicking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const words = draft ?? slot.words;
  const overallId = state.references.find((entry) => entry.role === 'overall').approvedImageId;
  const fetchPreview = useCallback((body, options) => previewBlenderModelReference(state.id, slot.id, body, options), [state.id, slot.id]);
  const preview = useModelInputPreview(fetchPreview, { words }, {
    enabled: !slot.locked, revision: JSON.stringify([state.name, state.description, state.referenceSource, overallId]),
  });
  const blocked = preview.error || preview.preview?.refusal;
  const rendering = slot.images.some((image) => image.status === 'rendering') || !!pending[`render:${slot.id}`];
  const render = async () => {
    const result = await model.renderReference(slot.id, words);
    if (result.ok) setDraft(null);
  };
  const review = async (referenceId, imageId, body) => {
    const result = await model.reviewReference(referenceId, imageId, body);
    // The note joins the saved words; keep an unsaved edit and add the note to it.
    if (result.ok && body.decision === 'redo' && draft !== null) setDraft([draft, body.note || ''].filter((text) => text.trim()).join('\n'));
    return result;
  };
  const images = [...slot.images].reverse();

  return (
    <section aria-label={title} className="min-w-0 space-y-2 border-t border-port-border pt-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h2 className="min-w-0 break-words text-sm font-medium">{title}</h2>
        {slot.outOfDate && <Pill size="xs" tone="warning">Out of date</Pill>}
        {slot.file && <code className="min-w-0 break-all font-mono text-xs text-port-text-muted">src/{slot.file}</code>}
      </div>
      {hint && <p className="text-xs text-port-text-muted">{hint}</p>}
      {slot.outOfDate && <p role="status" className="text-xs text-port-warning">The approved overall sheet changed since this plate was made. Render it again.</p>}
      {!slot.locked && (
        <div className="max-w-3xl min-w-0 space-y-2">
          <label htmlFor={`bm-words-${slot.id}`} className={labelCls}>Your words (optional)</label>
          <textarea id={`bm-words-${slot.id}`} rows={2} className={inputCls} value={words} maxLength={4000} onChange={(event) => setDraft(event.target.value)} />
          <ModelInputPreview preview={preview} prompt={words}
            referencesIntro={slot.role === 'closeup' ? 'The approved overall sheet comes first; the source images follow.' : 'The source images show the object to draw.'} />
          {preview.preview?.refusal && <p role="alert" className="text-xs text-port-warning">{preview.preview.refusal}</p>}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        <button type="button" className={primaryCls} disabled={slot.locked || rendering || !preview.preview || !!blocked} onClick={render}>
          <ImagePlus size={14} aria-hidden="true" /> {rendering ? 'Rendering…' : slot.images.length ? 'Render again' : 'Render'}
        </button>
        <button type="button" className={buttonCls} disabled={slot.locked || !!pending[`attach:${slot.id}`]} onClick={() => setPicking(true)}>
          <Images size={14} aria-hidden="true" /> Use an existing image
        </button>
        {removable && <button type="button" className={buttonCls} onClick={() => setRemoving(true)}><Trash2 size={14} aria-hidden="true" /> Remove plate</button>}
      </div>
      {removing && (
        <InlineConfirmRow autoFocus aria-label={`Confirm removing ${title}`} question={`Remove the "${title}" plate? Its images stay in the gallery.`}
          onConfirm={() => { setRemoving(false); model.removeCloseup(slot.id); }} onCancel={() => setRemoving(false)} />
      )}
      {images.length > 0 && (
        <ul aria-label={`${title} images`} className="grid min-w-0 grid-cols-1 gap-2 @2xl:grid-cols-2">
          {images.map((image) => <ReferenceImage key={image.id} model={{ ...model, reviewReference: review }} slot={slot} image={image} />)}
        </ul>
      )}
      <GalleryImagePicker open={picking} allowUpload onClose={() => setPicking(false)} onSelect={(item) => { if (item?.filename) model.attachReference(slot.id, item.filename); }} />
    </section>
  );
}
