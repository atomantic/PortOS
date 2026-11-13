import { useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import FilmLookControls from '../media/FilmLookControls.jsx';
import FilmLookPreview from '../media/FilmLookPreview.jsx';
import TemplateEffectsControls from './TemplateEffectsControls.jsx';
import useFilmLookPresets from '../../hooks/useFilmLookPresets.js';
import { FILM_LOOK_PRESETS, filmLookPreset, isFilmLookNeutral, normalizeFilmLook, sameFilmLook } from '../../lib/filmLook.js';
import { formatCount } from '../../utils/formatters.js';
import { shotCamera } from '../../../../server/lib/musicVideoFilmLook.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs hover:bg-port-border/40 pointer-fine:sm:min-h-0';
const presetLabel = (look) => (isFilmLookNeutral(look) ? 'Clean' : FILM_LOOK_PRESETS.find((p) => p.id === look?.preset)?.label || 'Custom');

/** Shot look controls shared by composed footage and composition documents. */
export default function ShotFilmLook({ project, scene, onChange, fieldId }) {
  const saved = useFilmLookPresets();
  const savedLooks = saved.presets;
  const [tuning, setTuning] = useState(null);
  const [shakeDraft, setShakeDraft] = useState(null);
  // Another shot closes Tune and drops a draft. Reset while rendering, not in an effect: a mount
  // effect that has not flushed yet runs after a first quick click and closes Tune again.
  const [shownScene, setShownScene] = useState(scene.sceneId);
  if (shownScene !== scene.sceneId) {
    setShownScene(scene.sceneId);
    setTuning(null);
    setShakeDraft(null);
  }
  const ownLook = scene.filmLook ? normalizeFilmLook(scene.filmLook) : null;
  const videoLook = normalizeFilmLook(project.filmLook);
  const camera = shotCamera(project, scene);
  const cameraLook = camera?.filmLook != null ? normalizeFilmLook(camera.filmLook) : null;
  const followLook = cameraLook != null ? cameraLook : videoLook;
  const savedMatch = ownLook && !FILM_LOOK_PRESETS.some((p) => p.id === ownLook.preset)
    ? savedLooks.find((preset) => sameFilmLook(preset.look, ownLook)) : null;
  // Frame shake is the look's gate weave, shown on its own so a shaking frame is never hidden behind Tune.
  // Setting it on a shot that follows the video gives the shot its own copy of the look, as Tune does.
  const shownLook = ownLook || followLook;
  const shake = shownLook?.weave ?? 0;
  const shakeShown = shakeDraft ?? shake;
  const commitShake = (value) => {
    if (shakeDraft == null) return;
    setShakeDraft(null);
    if (value === shake) return;
    const look = normalizeFilmLook({ ...(shownLook || filmLookPreset('none')), weave: value, preset: 'custom' });
    setTuning((open) => (open ? look : null));
    onChange({ filmLook: look });
  };
  const shakeSource = ownLook ? 'This shot\'s look' : cameraLook != null ? 'From this camera\'s look' : 'From the video\'s look';
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
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={fieldId('frame-shake')} className="text-[11px] text-port-text-muted">Frame shake</label>
        <input id={fieldId('frame-shake')} type="range" min={0} max={1} step={0.01} value={shakeShown}
          title="The film look's gate weave: the picture jitters a few pixels. Off unless you turn it on."
          onChange={(e) => setShakeDraft(Number(e.target.value))}
          onPointerUp={(e) => commitShake(Number(e.currentTarget.value))}
          onKeyUp={(e) => commitShake(Number(e.currentTarget.value))}
          onBlur={(e) => commitShake(Number(e.currentTarget.value))}
          className="min-h-[44px] min-w-16 max-w-48 flex-1 accent-port-accent pointer-fine:sm:min-h-0" />
        <span className="w-10 text-right text-xs tabular-nums">{shakeShown === 0 ? 'Off' : `${formatCount(Math.round(shakeShown * 100))}%`}</span>
        <span className="text-[11px] text-port-text-muted">{shakeSource}</span>
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
