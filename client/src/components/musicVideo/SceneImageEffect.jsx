import { safeReadStorage, safeWriteStorage } from '../../lib/safeStorage.js';
import { DEFAULT_IMAGE_EFFECT_SEC, IMAGE_EFFECT_DEVELOP_SECS, MUSIC_VIDEO_IMAGE_EFFECTS, MUSIC_VIDEO_IMAGE_EFFECT_LABELS } from '../../lib/musicVideoImageEffects.js';

// The develop length picked last on this device, for the next shot that takes an effect.
const LAST_SEC_KEY = 'portos-mv-image-effect-sec';
const lastDevelopSec = () => {
  const sec = Number(safeReadStorage(LAST_SEC_KEY));
  return IMAGE_EFFECT_DEVELOP_SECS.includes(sec) ? sec : DEFAULT_IMAGE_EFFECT_SEC;
};

/**
 * Where a shot's picture comes from in a composed render: a rendered clip, its
 * still, or its still playing a code-drawn image effect (a camera flash that
 * develops like an instant photo), which needs no model. An effect's develop
 * length rides beside it. The effect plays inside the shot's span and adds no time.
 */
export default function SceneImageEffect({ fieldId, scene, onChange, disabled = false, disabledReason = null }) {
  const effect = scene.visualLayer === 'still' && MUSIC_VIDEO_IMAGE_EFFECTS.includes(scene.imageEffect) ? scene.imageEffect : null;
  const value = effect || (scene.visualLayer === 'still' ? 'still' : 'clip');
  const developSec = IMAGE_EFFECT_DEVELOP_SECS.includes(scene.imageEffectSec) ? scene.imageEffectSec : DEFAULT_IMAGE_EFFECT_SEC;
  const spanSec = typeof scene.startSec === 'number' && typeof scene.endSec === 'number' ? scene.endSec - scene.startSec : null;
  const pick = (next) => {
    if (next === 'clip') onChange({ visualLayer: 'footage', ...(scene.imageEffect ? { imageEffect: null } : {}) });
    else if (next === 'still') onChange({ visualLayer: 'still', ...(scene.imageEffect ? { imageEffect: null } : {}) });
    else onChange({ visualLayer: 'still', imageEffect: next, imageEffectSec: scene.imageEffectSec || lastDevelopSec() });
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
            onChange={(e) => pick(e.target.value)}
            className="min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0 disabled:opacity-50">
            <option value="clip">Video clip</option>
            <option value="still">Still image</option>
            {MUSIC_VIDEO_IMAGE_EFFECTS.map((id) => <option key={id} value={id}>{MUSIC_VIDEO_IMAGE_EFFECT_LABELS[id]}</option>)}
          </select>
        </span>
        {effect && (
          <span className="flex min-w-0 items-center gap-1">
            <label htmlFor={fieldId('develop')} className="text-port-text-muted">Develops in</label>
            <select id={fieldId('develop')} value={developSec} onChange={(e) => pickSec(Number(e.target.value))}
              className="min-w-0 bg-port-bg border border-port-border rounded px-1 py-1 text-xs min-h-[44px] sm:min-h-0">
              {IMAGE_EFFECT_DEVELOP_SECS.map((sec) => <option key={sec} value={sec}>{sec}s</option>)}
            </select>
          </span>
        )}
      </div>
      {effect && (
        <p className="text-[11px] text-port-text-muted">
          {spanSec != null && developSec > spanSec
            ? `The shot ends at ${spanSec.toFixed(1)}s, before the photo finishes developing.`
            : 'No video render: the still plays the effect.'}
        </p>
      )}
    </div>
  );
}
