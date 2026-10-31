import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage.js';
import ScenePhotoSequence from './ScenePhotoSequence.jsx';
import {
  DEFAULT_IMAGE_EFFECT_SEC, IMAGE_EFFECT_CHANGE_SECS, IMAGE_EFFECT_DEVELOP_SECS, MUSIC_VIDEO_IMAGE_EFFECTS, MUSIC_VIDEO_IMAGE_EFFECT_LABELS,
  isEndFrameImageEffect,
} from '../../lib/musicVideoImageEffects.js';

// The develop length picked last on this device, for the next shot that takes an effect.
const LAST_SEC_KEY = 'portos-mv-image-effect-sec';
const lastDevelopSec = () => {
  const sec = Number(safeReadStorage(LAST_SEC_KEY));
  return IMAGE_EFFECT_DEVELOP_SECS.includes(sec) ? sec : DEFAULT_IMAGE_EFFECT_SEC;
};
const SELECT = 'min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50';

/**
 * Where a shot's picture comes from in a composed render: a rendered clip, its
 * still, or its still playing a code-drawn image effect, which needs no model:
 * a camera flash that develops like an instant photo (with its develop length),
 * or a fade, flash or glitch from the start frame to the end frame (with when
 * it changes, the middle of the shot by default). The effect plays inside the
 * shot's span and adds no time.
 */
export default function SceneImageEffect({ fieldId, scene, onChange, disabled = false, disabledReason = null, beats = [], fps = 24 }) {
  const effect = scene.visualLayer === 'still' && MUSIC_VIDEO_IMAGE_EFFECTS.includes(scene.imageEffect) ? scene.imageEffect : null;
  const toEnd = isEndFrameImageEffect(effect);
  const value = effect || (scene.visualLayer === 'still' ? 'still' : 'clip');
  const developSec = IMAGE_EFFECT_DEVELOP_SECS.includes(scene.imageEffectSec) ? scene.imageEffectSec : DEFAULT_IMAGE_EFFECT_SEC;
  const spanSec = typeof scene.startSec === 'number' && typeof scene.endSec === 'number' ? scene.endSec - scene.startSec : null;
  // Change points inside the shot; a saved one past a shortened shot reads Middle, as it plays.
  const changeSecs = IMAGE_EFFECT_CHANGE_SECS.filter((sec) => spanSec == null || sec < spanSec);
  const pick = (next) => {
    if (next === 'clip') onChange({ visualLayer: 'footage', ...(scene.imageEffect ? { imageEffect: null } : {}) });
    else if (next === 'still') onChange({ visualLayer: 'still', ...(scene.imageEffect ? { imageEffect: null } : {}) });
    // An end-frame effect changes mid-shot until a time is picked.
    else if (isEndFrameImageEffect(next)) onChange({ visualLayer: 'still', imageEffect: next, ...(toEnd ? {} : { imageEffectSec: null }) });
    else onChange({ visualLayer: 'still', imageEffect: next, imageEffectSec: toEnd || !scene.imageEffectSec ? lastDevelopSec() : scene.imageEffectSec });
  };
  const pickSec = (sec) => {
    safeWriteStorage(LAST_SEC_KEY, String(sec));
    onChange({ imageEffectSec: sec });
  };
  return (
    <div className="space-y-1 text-xs" data-testid="scene-image-effect">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-1">
          <label htmlFor={fieldId('picture')} className={effect ? 'text-port-accent' : 'text-port-text-muted'}>Picture</label>
          <select id={fieldId('picture')} value={value} disabled={disabled} title={disabledReason || undefined}
            onChange={(e) => pick(e.target.value)} className={SELECT}>
            <option value="clip">Video clip</option>
            <option value="still">Still image</option>
            {MUSIC_VIDEO_IMAGE_EFFECTS.map((id) => <option key={id} value={id}>{MUSIC_VIDEO_IMAGE_EFFECT_LABELS[id]}</option>)}
          </select>
        </span>
        {effect && !toEnd && (
          <span className="flex min-w-0 items-center gap-1">
            <label htmlFor={fieldId('develop')} className="text-port-text-muted">Develops in</label>
            <select id={fieldId('develop')} value={developSec} disabled={disabled} title={disabledReason || undefined}
              onChange={(e) => pickSec(Number(e.target.value))} className={SELECT}>
              {IMAGE_EFFECT_DEVELOP_SECS.map((sec) => <option key={sec} value={sec}>{sec}s</option>)}
            </select>
          </span>
        )}
        {toEnd && (
          <span className="flex min-w-0 items-center gap-1">
            <label htmlFor={fieldId('change')} className="text-port-text-muted">Changes at</label>
            <select id={fieldId('change')} value={changeSecs.includes(scene.imageEffectSec) ? scene.imageEffectSec : ''} disabled={disabled}
              title={disabledReason || undefined} onChange={(e) => onChange({ imageEffectSec: e.target.value ? Number(e.target.value) : null })} className={SELECT}>
              <option value="">Middle</option>
              {changeSecs.map((sec) => <option key={sec} value={sec}>{sec}s</option>)}
            </select>
          </span>
        )}
      </div>
      {effect && (
        <p className={`text-[11px] ${toEnd && !scene.endImageId ? 'text-port-warning' : 'text-port-text-muted'}`}>
          {toEnd && !scene.endImageId
            ? 'Needs an end frame: make or pick one beside the start frame. Until then the shot plays its still.'
            : !toEnd && spanSec != null && developSec > spanSec
              ? `The shot ends at ${spanSec.toFixed(1)}s, before the photo finishes developing.`
              : 'No video render: the still plays the effect.'}
        </p>
      )}
      {scene.visualLayer === 'still' && <ScenePhotoSequence scene={scene} fieldId={fieldId} onChange={onChange} disabled={disabled} beats={beats} fps={fps} />}
    </div>
  );
}
