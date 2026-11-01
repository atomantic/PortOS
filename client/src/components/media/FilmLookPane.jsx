import { useEffect, useState } from 'react';
import { Aperture, ChevronLeft, Save } from 'lucide-react';
import toast from '../ui/Toast';
import FilmLookControls from './FilmLookControls.jsx';
import useFilmLookPresets from '../../hooks/useFilmLookPresets.js';
import { applyImageFilmLook, getImageFilmLookSource } from '../../services/apiImageVideo';
import { filmLookPreset, isFilmLookNeutral, normalizeFilmLook } from '../../lib/filmLook.js';
import { visualProfileLook } from '../../../../server/lib/universeVisualProfile.js';

/**
 * The film look being tuned in the media viewer. The viewer shows the image
 * through `look` while the pane is open, so the state lives above both.
 *
 * Opening starts from the hosting project's look (or the image's own), never
 * from the last session's sliders. Stepping to another image while the pane is
 * open keeps the sliders, so one look can be compared across a set.
 *
 * A baked copy (`filmLookFrom`) is re-graded from its ungraded source, never
 * stacked on itself; `waiting` holds the preview and the save until it loads.
 */
export function useFilmLookDraft(item, open, projectLook = null) {
  const start = () => normalizeFilmLook(projectLook?.look) || normalizeFilmLook(item?.filmLook) || visualProfileLook(item?.visualProfile) || filmLookPreset('none');
  const [look, setLook] = useState(start);
  const [source, setSource] = useState(null);
  const [sourceError, setSourceError] = useState('');
  useEffect(() => { if (open) setLook(start()); }, [open]); // Dependency list is intentionally partial.
  useEffect(() => {
    let active = true;
    setSource(null);
    setSourceError('');
    if (open && item?.filename && item.filmLookFrom) {
      getImageFilmLookSource(item.filename, { silent: true }).then(result => { if (active) setSource(result); })
        .catch(error => { if (active) setSourceError(error.message || 'Could not load the ungraded source'); });
    }
    return () => { active = false; };
  }, [open, item?.filename, item?.filmLookFrom]);
  const waiting = !!item?.filmLookFrom && !source;
  return {
    look, setLook, source, sourceError, waiting,
    src: source?.path || item?.downloadUrl || item?.previewUrl,
  };
}

/**
 * Film look controls as the media viewer's side pane: tune the look on the
 * image beside it, then "Save filtered copy" bakes it into a new image next to
 * the untouched original (the server renders the same filter at full size).
 * Inside a music video project, "Use on project" makes it the project's
 * finishing look for the live preview and the final render.
 *
 * `projectLook` — optional `{ look, onSave(look), name }` from the hosting project.
 */
export default function FilmLookPane({ item, draft, onBack, onComplete, projectLook = null }) {
  const [saving, setSaving] = useState(false);
  const [savingProject, setSavingProject] = useState(false);
  const saved = useFilmLookPresets();
  const { look, setLook, source, waiting } = draft;
  const neutral = isFilmLookNeutral(look);
  const saveCopy = async () => {
    if (saving || neutral || waiting) return;
    setSaving(true);
    const variant = await applyImageFilmLook(source?.filename || item.filename, look, { silent: true }).catch((err) => {
      toast.error(err?.message || 'Could not save the filtered copy');
      return null;
    });
    setSaving(false);
    if (!variant) return;
    toast.success(`Saved ${variant.filename}`);
    await onComplete?.(variant);
    onBack();
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
    <section aria-labelledby="film-look-title" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-1 border-b border-port-border p-1.5">
        <button type="button" onClick={onBack} aria-label="Back to details" title="Back to details (Esc)"
          className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded text-port-text-muted hover:bg-port-border/50 hover:text-port-text">
          <ChevronLeft className="h-4 w-4" aria-hidden="true" />
        </button>
        <Aperture className="h-4 w-4 shrink-0 text-port-accent" aria-hidden="true" />
        <h2 id="film-look-title" className="truncate text-sm font-semibold text-port-text">Film look</h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <FilmLookControls look={look} onChange={setLook} saved={saved} />
      </div>
      <footer className="flex shrink-0 flex-wrap gap-2 border-t border-port-border p-2">
        <button type="button" onClick={saveCopy} disabled={saving || neutral || waiting} title={neutral ? 'Move a control first' : 'Render this look into a new image; the original stays as it is'}
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
      </footer>
    </section>
  );
}
