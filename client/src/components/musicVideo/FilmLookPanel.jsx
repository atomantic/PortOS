import { Aperture } from 'lucide-react';
import FilmLookControls from '../media/FilmLookControls.jsx';
import { isFilmLookNeutral } from '../../lib/filmLook.js';

/**
 * The project's finishing film look: the filter the composition live preview
 * and the final render are viewed through (lib/filmLook.js). Every slider move
 * reaches the docked preview at once (`onEditLocal`); releasing a control saves
 * (`onSave`). Source footage and generated images stay unchanged; to bake the
 * look into a still, open the image and use Film look there.
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
        <p className="text-xs text-port-text-muted" role="status">The film look is applied by the composition-document render style; this project's render style ignores it. It still works on any image through Film look in the image viewer.</p>
      )}
      <FilmLookControls look={project.filmLook} compact
        onChange={(look) => onEditLocal({ filmLook: look })}
        onCommit={(look) => onSave({ filmLook: isFilmLookNeutral(look) ? null : look })} />
    </section>
  );
}
