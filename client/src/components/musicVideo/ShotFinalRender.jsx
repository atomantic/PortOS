import { useEffect, useState } from 'react';
import { Activity, Film, Play, SlidersHorizontal, Square, X } from 'lucide-react';
import FilmLookControls from '../media/FilmLookControls.jsx';
import FilmLookPreview from '../media/FilmLookPreview.jsx';
import { cancelMusicVideoShotRender, musicVideoShotRenderUrl, renderMusicVideoShot } from '../../services/apiMusicVideo.js';
import useMusicVideoShotRenders from '../../hooks/useMusicVideoShotRenders.js';
import useFilmLookPresets from '../../hooks/useFilmLookPresets.js';
import { FILM_LOOK_PRESETS, filmLookPreset, isFilmLookNeutral, normalizeFilmLook, sameFilmLook } from '../../lib/filmLook.js';

const BUTTON = 'inline-flex min-h-[44px] items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs hover:bg-port-border/40 disabled:opacity-50 sm:min-h-0';
const presetLabel = (look) => (isFilmLookNeutral(look) ? 'Clean' : FILM_LOOK_PRESETS.find((p) => p.id === look?.preset)?.label || 'Custom');

/**
 * The shot's piece of the composed final render: whether its segment is
 * cached, Render shot to make it now (only this shot), a play of the rendered
 * shot with its film look, and the shot's own look (kept when the video's
 * look changes). The final render reuses every cached shot and stitches.
 */
export default function ShotFinalRender({ project, scene, onChange, fieldId }) {
  const projectId = project?.id;
  const sceneId = scene.sceneId;
  const { status, live: liveByShot, markLive } = useMusicVideoShotRenders(project);
  const live = liveByShot[sceneId] || null;
  const [playing, setPlaying] = useState(false);
  const [starting, setStarting] = useState(false);
  const saved = useFilmLookPresets();
  const savedLooks = saved.presets;
  const [tuning, setTuning] = useState(null); // the look being tuned, or null when closed

  useEffect(() => { setPlaying(false); setTuning(null); }, [sceneId]);

  if (!status?.available) return null;
  const shot = status.shots.find((entry) => entry.sceneId === sceneId);
  const rendering = live?.state === 'rendering' || (!live && shot?.rendering);
  const rendered = shot?.state === 'rendered' && !rendering;
  const file = rendered ? shot.files[shot.files.length - 1] : null;
  const ownLook = scene.filmLook ? normalizeFilmLook(scene.filmLook) : null;
  const videoLook = normalizeFilmLook(project.filmLook);
  const savedMatch = ownLook && !FILM_LOOK_PRESETS.some((p) => p.id === ownLook.preset)
    ? savedLooks.find((preset) => sameFilmLook(preset.look, ownLook)) : null;
  const lookValue = ownLook ? (FILM_LOOK_PRESETS.some((p) => p.id === ownLook.preset) ? ownLook.preset : savedMatch ? `saved:${savedMatch.id}` : 'own') : 'video';

  const start = () => {
    setStarting(true);
    markLive(sceneId, null);
    renderMusicVideoShot(projectId, sceneId, { silent: true })
      .then((result) => { if (result?.state === 'rendering') markLive(sceneId, { state: 'rendering', progress: 0 }); })
      .catch((err) => markLive(sceneId, { state: 'failed', error: err.message }))
      .finally(() => setStarting(false));
  };
  const pickLook = (value) => {
    setPlaying(false);
    setTuning(null);
    if (value === 'video') onChange({ filmLook: null });
    else if (value === 'keep') onChange({ filmLook: videoLook || filmLookPreset('none') });
    else if (value.startsWith('saved:')) {
      const preset = savedLooks.find((entry) => `saved:${entry.id}` === value);
      if (preset) onChange({ filmLook: normalizeFilmLook({ ...preset.look, preset: 'custom' }) });
    } else if (value !== 'own') onChange({ filmLook: filmLookPreset(value) });
  };

  const state = status.error ? null : rendering ? (live ? `Rendering ${Math.round((live.progress || 0) * 100)}%` : 'Rendering') : rendered ? 'Rendered' : shot ? 'Not rendered' : 'Not in the cut';
  return (
    <section aria-label="Final render" className="min-w-0 space-y-2 rounded border border-port-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="inline-flex items-center gap-1 text-xs font-medium"><Film size={14} aria-hidden="true" /> Final render</h4>
        {state && (
          <span data-testid="shot-render-state" className={`rounded px-1.5 text-[11px] ${rendered ? 'bg-port-success/10 text-port-success' : 'bg-port-border/60 text-port-text-muted'}`}>
            {rendering && <Activity size={11} className="mr-1 inline animate-spin" aria-hidden="true" />}{state}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {rendering ? (
            <button type="button" className={BUTTON} onClick={() => cancelMusicVideoShotRender(projectId, sceneId, { silent: true }).catch(() => {})}>
              <Square size={12} aria-hidden="true" /> Stop
            </button>
          ) : shot && !rendered ? (
            <button type="button" className={BUTTON} onClick={start} disabled={starting || !!status.error}>
              <Film size={12} aria-hidden="true" /> Render shot
            </button>
          ) : null}
          {file && (
            <button type="button" className={BUTTON} onClick={() => setPlaying((on) => !on)} aria-pressed={playing}>
              {playing ? <X size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />} {playing ? 'Close' : 'Play'}
            </button>
          )}
        </span>
      </div>
      {status.error && <p role="status" className="break-words text-[11px] text-port-warning">{status.error.message}</p>}
      {live?.state === 'failed' && live.error && <p role="alert" className="break-words text-[11px] text-port-error">{live.error}</p>}
      {playing && file && (
        // The rendered shot as the final render cuts it: film look and text, without the song.
        <video key={file} src={musicVideoShotRenderUrl(projectId, file)} controls autoPlay loop muted playsInline className="w-full rounded bg-black" />
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor={fieldId('film-look')} className="text-[11px] text-port-text-muted">Film look</label>
        <select id={fieldId('film-look')} value={lookValue} onChange={(e) => pickLook(e.target.value)}
          className="min-h-[44px] rounded border border-port-border bg-port-bg px-2 py-1 text-xs sm:min-h-0">
          <option value="video">Video&apos;s look ({presetLabel(videoLook)})</option>
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
          onClick={() => setTuning((open) => (open ? null : ownLook || videoLook || filmLookPreset('none')))}>
          <SlidersHorizontal size={12} aria-hidden="true" /> {tuning ? 'Done' : 'Tune'}
        </button>
      </div>
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
    </section>
  );
}
