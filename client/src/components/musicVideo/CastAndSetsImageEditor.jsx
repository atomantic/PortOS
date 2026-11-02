import { useCallback, useId, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { buildCastSetsImageEditPrompt, CAST_SETS_IMAGE_EDIT_MAX } from '../../../../server/lib/musicVideoCastSetsImageEdit.js';
import SentPromptPanel from '../media/SentPromptPanel.jsx';
import ModelInputPreview from '../media/ModelInputPreview.jsx';
import useModelInputPreview from '../../hooks/useModelInputPreview.js';
import { previewMusicVideoCastAndSetsImageEdit } from '../../services/apiMusicVideo.js';
import { formatCount } from '../../utils/formatters.js';

const buttonClass = 'min-h-[44px] rounded border border-port-border px-2 py-1 text-xs hover:bg-port-border/40 disabled:opacity-50';
const imageSrc = (filename) => `/data/images/${encodeURIComponent(filename)}`;

/** An image edit stays a candidate until the director accepts the before/after comparison. */
export default function CastAndSetsImageEditor({ projectId, item, image, revision, busy, onRender, onAccept, onDiscard }) {
  const inputId = useId();
  const [open, setOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const edit = image.edit;
  const stale = edit && (edit.revision !== revision || edit.inputs.imageId !== image.imageId);
  const pending = edit?.status === 'queued' && !stale;
  const ready = edit?.status === 'done' && !stale;
  const composed = buildCastSetsImageEditPrompt(instruction);
  const previewRequest = useCallback((body, options) => previewMusicVideoCastAndSetsImageEdit(projectId, body, options), [projectId]);
  const preview = useModelInputPreview(previewRequest, { key: item.key, revision, imageId: image.imageId, instruction }, {
    enabled: open && !pending && !ready && !!instruction.trim() && instruction.length <= CAST_SETS_IMAGE_EDIT_MAX,
  });
  const decision = edit ? { key: item.key, requestId: edit.requestId } : null;
  const label = item.label || item.key;
  return <div className="space-y-2">
    <button type="button" className={`${buttonClass} flex items-center gap-1`} disabled={busy} aria-expanded={open}
      onClick={() => setOpen(!open)} aria-label={`Edit this image: ${label}`}><ImagePlus size={12} aria-hidden="true" /> Edit this image</button>
    {open && !pending && !ready && <form className="space-y-2 rounded border border-port-border p-2" aria-label={`Image edit: ${label}`}
      onSubmit={(event) => { event.preventDefault(); onRender({ key: item.key, revision, imageId: image.imageId, instruction }); }}>
      <label htmlFor={inputId} className="block text-xs text-port-text-muted">Change only this
        <textarea id={inputId} className="mt-1 w-full min-w-0 rounded border border-port-border bg-port-bg px-2 py-1.5 text-sm" rows={3}
          value={instruction} onChange={(event) => setInstruction(event.target.value)} />
      </label>
      <p className={`text-[11px] ${instruction.length > CAST_SETS_IMAGE_EDIT_MAX ? 'text-port-error' : 'text-port-text-muted'}`}>
        {formatCount(instruction.length)} / {formatCount(CAST_SETS_IMAGE_EDIT_MAX)} characters. Only this card’s current image is sent as the image input.
      </p>
      {instruction.trim() ? <ModelInputPreview prompt={instruction} preview={preview} />
        : <SentPromptPanel prompt={instruction} sentPrompt={composed.prompt} additions={composed.promptAdditions} />}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass} disabled={busy || !instruction.trim() || instruction.length > CAST_SETS_IMAGE_EDIT_MAX || !preview.preview || !!preview.error}>Render image edit</button>
        <button type="button" className={buttonClass} onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </form>}
    {edit && <div className="space-y-2 rounded border border-port-border p-2" aria-label={`Image edit preview: ${label}`}>
      {stale ? <p role="status" className="text-xs text-port-warning">This edit belongs to an older image. Discard it and try again.</p>
        : pending ? <p role="status" className="text-xs text-port-text-muted">Rendering image edit… The current image stays in use until you accept.</p>
          : edit.status === 'failed' ? <p role="alert" className="text-xs text-port-error">{edit.error}</p> : null}
      {ready && <>
        <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
          {[[image.imageId, 'Before'], [edit.imageId, 'After']].map(([filename, title]) => <figure key={title} className="min-w-0">
            <img src={imageSrc(filename)} alt={`${label} — ${title.toLowerCase()} image edit`} className="max-h-64 w-full rounded object-contain" />
            <figcaption className="text-xs text-port-text-muted">{title}</figcaption>
          </figure>)}
        </div>
        <p className="whitespace-pre-wrap break-words text-xs">{edit.instruction}</p>
        <SentPromptPanel prompt={edit.instruction} sentPrompt={edit.modelInput?.sentPrompt || edit.prompt} additions={edit.modelInput?.promptAdditions || edit.promptAdditions} />
        <p className="text-[11px] text-port-text-muted">Accept updates this card for check-in review. Approve the updated check-in to publish its references and catalog sheets.</p>
      </>}
      <div className="flex flex-wrap gap-2">
        {ready && <button type="button" className={`${buttonClass} bg-port-accent text-white`} disabled={busy} onClick={() => onAccept(decision)}>Accept image edit</button>}
        <button type="button" className={buttonClass} disabled={busy} onClick={() => onDiscard(decision)}>Discard image edit</button>
      </div>
    </div>}
  </div>;
}
