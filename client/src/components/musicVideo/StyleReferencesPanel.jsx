import { useEffect, useState } from 'react';
import useMounted from '../../hooks/useMounted.js';
import { uploadGalleryImage } from '../../services/apiSystem.js';
import { IMAGE_ACCEPT, readFileAsBase64, validateImageFile } from '../../utils/fileUpload.js';
import toast from '../ui/Toast';

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
