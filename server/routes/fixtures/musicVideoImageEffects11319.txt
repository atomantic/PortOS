/**
 * Music Video image effects: a still shot that plays a code-drawn effect over
 * its still instead of a generated clip, so no model is called for it. The
 * shot is a still section (`visualLayer: 'still'`) that also names an
 * `imageEffect`; only a layered (composed) render honours it, as it does the
 * still itself.
 *
 * "Camera flash develop" (`flash-develop`): the shot opens on a white camera
 * flash, then the picture develops like an instant photo over
 * `imageEffectSec` seconds: a murky grey-green emulsion clears, the contrast
 * comes up and the colour fills in last, and the still holds fully developed
 * for the rest of the shot. The effect never adds time: it plays inside the
 * shot's own span, and a develop longer than the shot ends the shot part-way.
 *
 * One definition serves both players: every value is a pure function of the
 * time into the shot (`imageEffectState`), the storyboard animatic paints it
 * with CSS over the still, and the final render turns the same curves into
 * ffmpeg filters (`musicVideoImageEffectFilter`). Each curve is linear or a
 * square of a linear ramp so the two read the same frame for frame.
 */

export const MUSIC_VIDEO_IMAGE_EFFECTS = Object.freeze(['flash-develop']);

export const MUSIC_VIDEO_IMAGE_EFFECT_LABELS = Object.freeze({
  'flash-develop': 'Camera flash develop',
});

/** The develop lengths the shot card offers, in seconds. */
export const IMAGE_EFFECT_DEVELOP_SECS = Object.freeze([1, 2, 3, 4, 6, 8]);
export const DEFAULT_IMAGE_EFFECT_SEC = 3;
export const IMAGE_EFFECT_SEC_RANGE = Object.freeze({ min: 0.5, max: 30 });

// The flash fades from full white to nothing over this long.
const FLASH_SEC = 0.25;
// The undeveloped emulsion's colour, and the share of the develop it takes to clear.
export const IMAGE_EFFECT_FOG_COLOR = '#4a5452';
const FOG_SHARE = 0.75;
// Contrast starts here and rises to 1 as the picture develops.
const START_CONTRAST = 0.55;

const isEffect = (value) => MUSIC_VIDEO_IMAGE_EFFECTS.includes(value);
const clampSec = (sec) => Math.min(IMAGE_EFFECT_SEC_RANGE.max, Math.max(IMAGE_EFFECT_SEC_RANGE.min, sec));

/**
 * The effect a scene plays, `{ effect, developSec }`, or null. Only a still
 * shot in a layered composition plays one: anywhere else the shot shows its
 * footage as before.
 */
export function sceneImageEffect(scene, { layered = false } = {}) {
  if (!layered || scene?.visualLayer !== 'still' || !isEffect(scene?.imageEffect)) return null;
  const sec = Number(scene.imageEffectSec);
  return { effect: scene.imageEffect, developSec: Number.isFinite(sec) && sec > 0 ? clampSec(sec) : DEFAULT_IMAGE_EFFECT_SEC };
}

const ramp = (tSec, sec) => Math.min(1, Math.max(0, tSec / sec));

/**
 * The effect's state `tSec` seconds into the shot: `flash` and `fog` are the
 * opacities of the white flash and the emulsion colour over the picture, and
 * `contrast` / `saturation` the picture's own (1 = as shot).
 */
export function imageEffectState({ effect, developSec }, tSec) {
  if (effect !== 'flash-develop') return { flash: 0, fog: 0, contrast: 1, saturation: 1 };
  const t = Math.max(0, tSec);
  const progress = ramp(t, developSec);
  return {
    flash: 1 - ramp(t, FLASH_SEC),
    fog: 1 - ramp(t, developSec * FOG_SHARE),
    contrast: START_CONTRAST + (1 - START_CONTRAST) * progress,
    saturation: progress * progress,
  };
}

const num = (n) => String(Math.round(n * 10000) / 10000);

/**
 * The ffmpeg filtergraph that plays `effect` over one section, appended to the
 * section's chain after its frames start counting from 0. Returns the text to
 * append (it begins with a comma and ends on the effected stream, unlabelled,
 * so the caller's output label follows), or '' for no effect. `atSec` is how
 * far into the shot the section starts (a shot cut into pieces picks up where
 * its last piece left off); `key` keeps the graph's labels unique per section.
 */
export function musicVideoImageEffectFilter(effectSpec, { width, height, fps, key, atSec = 0 }) {
  if (effectSpec?.effect !== 'flash-develop') return '';
  const startFrame = Math.max(0, atSec) * fps;
  const progress = `min(1,(n+${num(startFrame)})/${num(Math.max(1, effectSpec.developSec * fps))})`;
  let chain = `,eq=contrast='${num(START_CONTRAST)}+${num(1 - START_CONTRAST)}*${progress}':saturation='${progress}*${progress}':eval=frame`;
  // A layer fading out over `sec` from the shot's start: from where it stands at `atSec`, linearly to nothing.
  const layer = (name, color, sec) => {
    const left = sec - Math.max(0, atSec);
    const frames = Math.round(left * fps);
    if (frames < 1) return;
    chain += `[fxin${name}${key}];color=c=${color}@${num(left / sec)}:s=${width}x${height}:r=${fps},format=yuva420p,`
      + `fade=t=out:start_frame=0:nb_frames=${frames}:alpha=1[fx${name}${key}];[fxin${name}${key}][fx${name}${key}]overlay=shortest=1:format=auto`;
  };
  layer('fog', `0x${IMAGE_EFFECT_FOG_COLOR.slice(1)}`, effectSpec.developSec * FOG_SHARE);
  layer('flash', 'white', FLASH_SEC);
  return `${chain},format=yuv420p`;
}
