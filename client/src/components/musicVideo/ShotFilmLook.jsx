import { useEffect, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import FilmLookControls from '../media/FilmLookControls.jsx';
import FilmLookPreview from '../media/FilmLookPreview.jsx';
import TemplateEffectsControls from './TemplateEffectsControls.jsx';
import useFilmLookPresets from '../../hooks/useFilmLookPresets.js';
import { FILM_LOOK_PRESETS, filmLookPreset, isFilmLookNeutral, normalizeFilmLook, sameFilmLook } from '../../lib/filmLook.js';
import { shotCamera } from '../../../../server/lib/musicVideoFilmLook.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs hover:bg-port-border/40 pointer-fine:sm:min-h-0';
const presetLabel = (look) => (isFilmLookNeutral(look) ? 'Clean' : FILM_LOOK_PRESETS.find((p) => p.id === look?.preset)?.label || 'Custom');

/** Shot look controls shared by composed footage and composition documents. */
export default function ShotFilmLook({ project, scene, onChange, fieldId }) {
  const saved = useFilmLookPresets();
  const savedLooks = saved.presets;
  const [tuning, setTuning] = useState(null);
  useEffect(() => { setTuning(null); }, [scene.sceneId]);
  const ownLook = scene.filmLook ? normalizeFilmLook(scene.filmLook) : null;
  const videoLook = normalizeFilmLook(project.filmLook);
  const camera = shotCamera(project, scene);
  const cameraLook = camera?.filmLook != null ? normalizeFilmLook(camera.filmLook) : null;
  const followLook = cameraLook != null ? cameraLook : videoLook;
  const savedMatch = ownLook && !FILM_LOOK_PRESETS.some((p) => p.id === ownLook.preset)
    ? savedLooks.find((preset) => sameFilmLook(preset.look, ownLook)) : null;
  const lookValue = ownLook ? (FILM_LOOK_PRESETS.some((p) => p.id === ownLook.preset) ? ownLook.preset : savedMatch ? `saved:${savedMatch.id}` : 'own') : 'video';

  const pickLook = (value) => {
    setTuning(null);
    if (value === 'video') onChange({ filmLook: null });
    else if (value === 'keep') onChange({ filmLook: videoLook || filmLookPreset('none') });
    else if (value.startsWith('saved:')) {
      const preset = savedLooks.find((entry) => `saved:${entry.id}` === value);
      if (preset) onChange({ filmLook: normalizeFilmLook({ ...preset.look, preset: 'custom' }) });
    } else if (value !== 'own') onChange({ filmLook: filmLookPreset(value) });
  };
  return (
    <div className="space-y-2" aria-label="Shot film look">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={fieldId('film-look')} className="text-[11px] text-port-text-muted">Film look</label>
        <select id={fieldId('film-look')} value={lookValue} onChange={(e) => pickLook(e.target.value)}
          className="min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-xs pointer-fine:sm:min-h-0">
          <option value="video">{cameraLook != null ? 'This camera\'s look' : 'Video\'s look'} ({presetLabel(followLook)})</option>
          {!ownLook && <option value="keep">Keep the video&apos;s look on this shot</option>}
          {lookValue === 'own' && <option value="own">This shot&apos;s look ({presetLabel(ownLook)})</option>}
          {FILM_LOOK_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
          {savedLooks.length > 0 && (
            <optgroup label="Your looks">
              {savedLooks.map((preset) => <option key={preset.id} value={`saved:${preset.id}`}>{preset.label}</option>)}
            </optgroup>
          )}
        </select>
        <button type="button" className={BUTTON} aria-expanded={!!tuning}
          onClick={() => setTuning((open) => (open ? null : ownLook || followLook || filmLookPreset('none')))}>
          <SlidersHorizontal size={12} aria-hidden="true" /> {tuning ? 'Done' : 'Tune'}
        </button>
      </div>
      {project.composition?.mode === 'document' && <TemplateEffectsControls project={project} scene={scene} onCommit={onChange} />}
      {tuning && (
        // This shot's own look, slider by slider, on its still: subtle fixes
        // (a little haze on one clean shot) without a whole preset.
        <div className="space-y-2" aria-label="Tune this shot's look" role="group">
          {scene.referenceImageId && (
            <FilmLookPreview src={`/data/images/${scene.referenceImageId}`} alt="This shot" look={tuning}
              className="flex items-center justify-center overflow-hidden rounded bg-black [&_img]:max-h-[30dvh]" />
          )}
          <FilmLookControls look={tuning} compact saved={saved}
            onChange={setTuning}
            onCommit={(look) => { setTuning(look); onChange({ filmLook: look }); }} />
        </div>
      )}
    </div>
  );
}
