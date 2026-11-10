import { useEffect, useId, useState } from 'react';
import { TEMPLATE_EFFECT_CONTROLS, templateEffects } from '../../../../server/lib/musicVideoTemplateEffects.js';
import { shotFilmLook } from '../../../../server/lib/musicVideoFilmLook.js';
import { normalizeFilmLook } from '../../lib/filmLook.js';
import { formatCount } from '../../utils/formatters.js';

/** Built-in composition additions; selected effects and the film look remain independent. */
export default function TemplateEffectsControls({ project, scene = null, onChange, onCommit }) {
  const prefix = useId();
  const value = (scene || project).templateEffects;
  const [draft, setDraft] = useState(null);
  useEffect(() => { setDraft(null); }, [project.id, scene?.sceneId, value]);
  const current = draft ?? value;
  const resolved = templateEffects({ ...project, ...(!scene ? { templateEffects: current } : {}) }, scene ? { ...scene, templateEffects: current } : null);
  const look = scene ? shotFilmLook(project, scene) : normalizeFilmLook(project.filmLook);
  const stacked = (resolved.grain > 0 && look?.grain > 0) || (resolved.vignette > 0 && look?.vignette > 0);
  const patch = (id, amount) => ({ templateEffects: { ...current, [id]: amount } });
  const commit = (next) => { setDraft(null); onCommit(next); };
  return (
    <fieldset aria-label={scene ? 'Shot template additions' : 'Template additions'} className="space-y-2 rounded border border-port-border p-2 text-xs">
      <legend className="px-1 font-medium">Template additions{scene ? ' · this shot' : ''}</legend>
      <p className="text-port-text-muted">The layered composition applies these on top of your shots. Beat reaction adds a pulse and chorus glitch. Handheld shake and footsteps move the frame like a person holding the camera and walking. Zero turns an addition off; chosen glitches, transitions and Film look still apply.</p>
      <p className="text-port-text-muted">Existing documents need Update layered engine to use these controls. Custom and 3D engines keep their own behavior.</p>
      {TEMPLATE_EFFECT_CONTROLS.map(({ id, label }) => (
        <div key={id} className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${prefix}-${id}`} className="w-32 shrink-0">{label}</label>
          <input id={`${prefix}-${id}`} type="range" min={0} max={1} step={0.01} value={resolved[id]}
            onChange={(event) => { const next = patch(id, Number(event.target.value)); setDraft(next.templateEffects); onChange?.(next); }}
            onPointerUp={(event) => commit(patch(id, Number(event.currentTarget.value)))}
            onKeyUp={(event) => commit(patch(id, Number(event.currentTarget.value)))}
            className="min-h-[44px] min-w-16 flex-1 pointer-fine:sm:min-h-0" />
          <span className="w-10 text-right tabular-nums">{resolved[id] === 0 ? 'Off' : `${formatCount(Math.round(resolved[id] * 100))}%`}</span>
          {scene && <button type="button" disabled={value?.[id] == null} onClick={() => commit(patch(id, null))}
            className="min-h-[44px] text-port-accent disabled:text-port-text-muted pointer-fine:sm:min-h-0" aria-label={`Follow video for ${label}`}>Follow video</button>}
        </div>
      ))}
      {stacked && <p role="note" className="text-port-text-muted">Template grain or vignette is on alongside Film look texture; both layers will draw.</p>}
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => commit({ templateEffects: Object.fromEntries(TEMPLATE_EFFECT_CONTROLS.map(({ id }) => [id, 0])) })}
          className="min-h-[44px] text-port-accent pointer-fine:sm:min-h-0">Turn all off</button>
        <button type="button" onClick={() => commit({ templateEffects: null })}
          className="min-h-[44px] text-port-accent pointer-fine:sm:min-h-0">{scene ? 'Follow video for all' : 'Restore template defaults'}</button>
      </div>
    </fieldset>
  );
}
