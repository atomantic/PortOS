import { useEffect, useState } from 'react';
import { Aperture, Save, X } from 'lucide-react';
import Modal from '../ui/Modal';
import toast from '../ui/Toast';
import FilmLookControls from './FilmLookControls.jsx';
import FilmLookPreview from './FilmLookPreview.jsx';
import { applyImageFilmLook } from '../../services/apiImageVideo';
import { filmLookPreset, isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';

/**
 * Tune a film look on one gallery image and keep it: "Save filtered copy"
 * bakes the look into a new image beside the untouched original (the server
 * renders the same filter at full size), and, inside a music video project,
 * "Use on project" makes it the project's finishing look for the live preview
 * and the final render.
 *
 * `projectLook` — optional `{ look, onSave(look), name }` from the hosting
 * project: the editor starts from that look and can write back to it.
 */
export default function FilmLookEditor({ item, open, onClose, onComplete, projectLook = null }) {
  const start = () => normalizeFilmLook(projectLook?.look) || normalizeFilmLook(item?.filmLook) || filmLookPreset('none');
  const [look, setLook] = useState(start);
  const [saving, setSaving] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  // A different image (or a reopen) starts over from the project's look, never from the last session's sliders.
  useEffect(() => { if (open) setLook(start()); }, [open, item?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!item) return null;
  const neutral = isFilmLookNeutral(look);
  const saveCopy = async () => {
    if (saving || neutral) return;
    setSaving(true);
    const variant = await applyImageFilmLook(item.filename, look, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not save the filtered copy');
      return null;
    });
    setSaving(false);
    if (!variant) return;
    toast.success(`Saved ${variant.filename}`);
    await onComplete?.(variant);
    onClose();
  };
  const saveProject = async () => {
    if (!projectLook?.onSave || savingProject) return;
    setSavingProject(true);
    await Promise.resolve(projectLook.onSave(neutral ? null : look))
      .then(() => toast.success(neutral ? 'Project look cleared' : `Look saved to ${projectLook.name || 'the project'}`))
      .catch((err) => toast.error(err?.message || 'Could not save the project look'))
      .finally(() => setSavingProject(false));
  };
  return (
    <Modal open={open} onClose={onClose} size="3xl" zIndexClassName="z-[70]" backdropClassName="bg-black/85" ariaLabelledBy="film-look-title"
      panelClassName="overflow-hidden bg-port-card border border-port-border rounded-xl shadow-2xl flex flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-port-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Aperture className="h-4 w-4 shrink-0 text-port-accent" aria-hidden="true" />
          <h2 id="film-look-title" className="truncate text-sm font-semibold text-port-text">Film look</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded p-1.5 text-port-text-muted hover:text-port-text">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <div className="flex max-h-[42dvh] shrink-0 items-center justify-center bg-black md:max-h-none md:flex-1">
          <FilmLookPreview src={item.downloadUrl || item.previewUrl} alt={item.prompt} look={look} className="flex max-h-[42dvh] items-center justify-center md:max-h-[80dvh]" />
        </div>
        <div className="flex min-h-0 w-full flex-col border-t border-port-border md:w-96 md:border-l md:border-t-0">
          <div className="min-h-0 flex-1 overflow-y-auto p-3">
            <FilmLookControls look={look} onChange={setLook} />
          </div>
          <div className="flex flex-wrap gap-2 border-t border-port-border p-2">
            <button type="button" onClick={saveCopy} disabled={saving || neutral} title={neutral ? 'Move a control first' : 'Render this look into a new image; the original stays as it is'}
              className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded bg-port-accent px-3 text-xs text-white disabled:opacity-50">
              <Save className="h-3.5 w-3.5" aria-hidden="true" /> {saving ? 'Saving…' : 'Save filtered copy'}
            </button>
            {projectLook?.onSave && (
              <button type="button" onClick={saveProject} disabled={savingProject}
                title="Make this the project's finishing look: the live preview and the final render are viewed through it"
                className="inline-flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded border border-port-accent px-3 text-xs text-port-accent disabled:opacity-50">
                {savingProject ? 'Saving…' : neutral ? 'Clear project look' : 'Use on project'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
