import { Aperture } from 'lucide-react';
import FilmLookControls from '../media/FilmLookControls.jsx';
import { isFilmLookNeutral } from '../../lib/filmLook.js';

/**
 * The project's finishing film look: the filter the docked preview (the
 * composition document or the storyboard animatic) and the final render are
 * viewed through (lib/filmLook.js). Every slider move reaches the preview at
 * once (`onEditLocal`); releasing a control saves (`onSave`). Source footage
 * and generated images stay unchanged: a document render draws through the
 * filter, a footage render gets it as a finishing pass over the finished cut,
 * and a still is baked only from Film look in the image viewer.
 */
export default function FilmLookPanel({ project, onEditLocal, onSave }) {
  const documentMode = project.composition?.mode === 'document';
  const on = !isFilmLookNeutral(project.filmLook);
  return (
    <section aria-label="Film look" className="space-y-2 border-t border-port-border pt-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-medium"><Aperture size={14} className="text-port-accent" aria-hidden="true" /> Film look</h3>
        <span className="text-xs text-port-text-muted">{on ? 'Live in the preview · applied to the final render' : 'Off'}</span>
      </div>
      {!documentMode && (
        <p className="text-xs text-port-text-muted">Applied as a finishing pass after the cut is encoded, so the clips themselves never change; the animatic shows it live.</p>
      )}
      <FilmLookControls look={project.filmLook} compact
        onChange={(look) => onEditLocal({ filmLook: look })}
        onCommit={(look) => onSave({ filmLook: isFilmLookNeutral(look) ? null : look })} />
    </section>
  );
}
