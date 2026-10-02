import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink } from 'lucide-react';
import useMounted from '../../hooks/useMounted.js';
import { getMoodBoard } from '../../services/apiMoodBoard.js';
import { moodBoardItemSrc } from '../../lib/moodBoardItemSrc.js';
import { uploadGalleryImage } from '../../services/apiSystem.js';
import { IMAGE_ACCEPT, readFileAsBase64, validateImageFile } from '../../utils/fileUpload.js';
import toast from '../ui/Toast';

const LINKED_THUMBS = 6;

/**
 * The mood board linked to the project (`visualSpec.moodBoardId` — the one an
 * autonomous run creates or the creative setup picks): its name, a few pinned
 * images and a link to the board, so an empty uploader below is not read as
 * "no moodboard". Read-only; the board page is where it is edited.
 */
function LinkedMoodBoard({ boardId }) {
  const [board, setBoard] = useState(null); // null = not loaded (or failed), else the full board
  useEffect(() => {
    let active = true;
    setBoard(null);
    getMoodBoard(boardId, { silent: true }).then((data) => { if (active) setBoard(data || null); }, () => {});
    return () => { active = false; };
  }, [boardId]);
  const thumbs = useMemo(() => (Array.isArray(board?.items) ? board.items : [])
    .map((item) => ({ id: item.id, src: moodBoardItemSrc(item) })).filter((t) => t.src).slice(0, LINKED_THUMBS), [board]);
  return (
    <div className="rounded border border-port-border bg-port-bg p-2 space-y-2" data-testid="linked-mood-board">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <span className="text-port-text-muted">Linked mood board</span>
        <Link to={`/mood-boards/${encodeURIComponent(boardId)}`} className="inline-flex items-center gap-1 text-port-accent hover:underline min-h-[44px] sm:min-h-0">
          {board?.name || 'Open mood board'} <ExternalLink size={12} aria-hidden="true" />
        </Link>
      </div>
      {thumbs.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {thumbs.map((t, i) => (
            <li key={t.id || i}><img src={t.src} alt={`Mood board image ${i + 1}`} loading="lazy" className="h-12 w-12 rounded object-cover" /></li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Project-owned moodboard; uploads do not invoke an AI provider. */
export default function StyleReferencesPanel({ project, onSave, onPendingChange }) {
  const mounted = useMounted();
  const [references, setReferences] = useState(project.styleReferences || []);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onPendingChange?.(dirty || busy);
    return () => onPendingChange?.(false);
  }, [dirty, busy, onPendingChange]);
  useEffect(() => {
    if (!dirty && !busy) setReferences(project.styleReferences || []);
  }, [project.styleReferences, dirty, busy]);
  const change = (next) => {
    setReferences(next);
    setDirty(true);
  };
  const upload = async (files) => {
    if (busy || !files.length) return;
    if (references.length + files.length > 8) { toast.error('Choose at most eight moodboard images'); return; }
    const error = files.map((file) => !IMAGE_ACCEPT.split(',').includes(file.type)
      ? 'Use PNG, JPEG or WebP moodboard images' : validateImageFile(file)).find(Boolean);
    if (error) { toast.error(error); return; }
    setBusy(true);
    let next = [...references];
    try {
      for (const file of files) {
        const encoded = await readFileAsBase64(file);
        const { filename } = await uploadGalleryImage(encoded, { silent: true });
        if (!mounted.current) return;
        next = [...next, { imageId: filename, caption: '' }];
        change(next);
      }
    } catch (err) {
      toast.error(err?.message || 'Moodboard upload failed');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  const save = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onSave({ styleReferences: references });
      if (mounted.current) setDirty(false);
    } catch (err) {
      toast.error(err?.message || 'Moodboard save failed');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Project moodboard" className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
      <h3 className="text-sm font-medium">Project moodboard</h3>
      <p className="text-xs text-port-text-muted">Up to eight style images. Add captions describing palette, lighting, lens and grain. Identity references take priority; models use as many style images as their remaining slots allow, or caption text when references are unsupported.</p>
      {project.visualSpec?.moodBoardId && <LinkedMoodBoard boardId={project.visualSpec.moodBoardId} />}
      <fieldset disabled={busy} className="space-y-2">
        <label htmlFor={`mv-style-upload-${project.id}`} className="block text-xs">Upload style images
          <input id={`mv-style-upload-${project.id}`} type="file" aria-label="Upload style images" accept={IMAGE_ACCEPT} multiple disabled={references.length >= 8 || busy}
            onChange={(e) => { const files = Array.from(e.target.files || []); e.target.value = ''; upload(files); }}
            className="block w-full text-sm min-h-[44px]" />
        </label>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {references.map((ref, index) => (
            <li key={ref.imageId} className="flex gap-2 rounded border border-port-border p-2">
              <img src={`/data/images/${encodeURIComponent(ref.imageId)}`} alt={`Style reference ${index + 1}`} className="h-16 w-16 rounded object-cover" />
              <label htmlFor={`mv-style-caption-${project.id}-${index}`} className="flex-1 text-xs">Style caption {index + 1}
                <textarea id={`mv-style-caption-${project.id}-${index}`} value={ref.caption || ''} maxLength={500} rows={2}
                  onChange={(e) => change(references.map((item, i) => i === index ? { ...item, caption: e.target.value } : item))}
                  className="block w-full rounded border border-port-border bg-port-bg p-1 text-sm" />
              </label>
              <button type="button" aria-label={`Remove style reference ${index + 1}`} onClick={() => change(references.filter((_, i) => i !== index))}
                className="min-h-[44px] text-xs text-port-error">Remove</button>
            </li>
          ))}
        </ul>
        <button type="button" disabled={!dirty || busy} onClick={save} className="min-h-[44px] rounded bg-port-accent px-3 text-sm text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save moodboard'}</button>
      </fieldset>
      {dirty && <p className="text-xs text-port-warning">Save the moodboard before starting generation.</p>}
    </section>
  );
}
