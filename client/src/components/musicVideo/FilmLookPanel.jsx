import { useId, useState } from 'react';
import { Aperture } from 'lucide-react';
import FilmLookControls from '../media/FilmLookControls.jsx';
import FilmLookPreview from '../media/FilmLookPreview.jsx';
import useFilmLookPresets from '../../hooks/useFilmLookPresets.js';
import { isFilmLookNeutral } from '../../lib/filmLook.js';

// The look on one shot's still, right above the sliders: a single SVG filter
// evaluation per change, which a phone can afford where a playing video can't.
function ShotSample({ project, activeSceneId }) {
  const selectId = useId();
  const shots = (project.scenes || []).map((scene, index) => ({ scene, number: index + 1 })).filter(({ scene }) => scene.referenceImageId);
  const [pickedId, setPickedId] = useState(null);
  if (!shots.length) return null;
  const sample = shots.find(({ scene }) => scene.sceneId === (pickedId || activeSceneId)) || shots[0];
  return (
    <div className="sticky top-0 z-10 space-y-1 bg-port-card pb-1">
      <div className="flex items-center gap-2 text-xs">
        <label htmlFor={selectId} className="text-port-text-muted">Sample</label>
        <select id={selectId} value={sample.scene.sceneId} onChange={(event) => setPickedId(event.target.value)}
          className="min-h-[44px] min-w-0 flex-1 rounded border border-port-border bg-port-bg px-2 py-1 sm:min-h-0">
          {shots.map(({ scene, number }) => (
            <option key={scene.sceneId} value={scene.sceneId}>Shot {number}{scene.sectionLabel ? ` · ${scene.sectionLabel}` : ''}</option>
          ))}
        </select>
      </div>
      <FilmLookPreview src={`/data/images/${sample.scene.referenceImageId}`} alt={`Shot ${sample.number}`} look={project.filmLook}
        className="flex items-center justify-center overflow-hidden rounded bg-black [&_img]:max-h-[30dvh]" />
    </div>
  );
}

/**
 * The project's finishing film look: the filter the docked preview (the
 * composition document or the storyboard animatic) and the final render are
 * viewed through (lib/filmLook.js). Every slider move reaches the preview at
 * once (`onEditLocal`); releasing a control saves (`onSave`). Source footage
 * and generated images stay unchanged: a document render draws through the
 * filter, a footage render gets it as a finishing pass over the finished cut,
 * and a still is baked only from Film look in the image viewer.
 */
export default function FilmLookPanel({ project, activeSceneId = null, onEditLocal, onSave }) {
  const saved = useFilmLookPresets();
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
      <ShotSample project={project} activeSceneId={activeSceneId} />
      <FilmLookControls look={project.filmLook} compact saved={saved}
        onChange={(look) => onEditLocal({ filmLook: look })}
        onCommit={(look) => onSave({ filmLook: isFilmLookNeutral(look) ? null : look })} />
    </section>
  );
}
