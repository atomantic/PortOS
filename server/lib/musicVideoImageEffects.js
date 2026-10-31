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
 * Three effects play from the shot's start frame to its end frame
 * (`endImageId`), changing `imageEffectSec` seconds in (the middle of the shot
 * when unset): "Fade to end frame" dissolves over FADE_SEC, "Flash to end
 * frame" cuts under a white camera flash, and "Glitch to end frame" cuts under
 * a VHS glitch (the cut transitions' own `vhs-glitch` frames). Without an end
 * frame the shot plays its still.
 *
 * One definition serves both players: every value is a pure function of the
 * time into the shot (`imageEffectState`), the storyboard animatic paints it
 * with CSS over the still, and the final render turns the same curves into
 * ffmpeg filters (`musicVideoImageEffectFilter`). Each curve is linear or a
 * square of a linear ramp so the two read the same frame for frame.
 */

// No imports: document videos ship this file as is (compositionDocument.js), so it
// stays self-contained. Glitch frames for `end-glitch` live in musicVideoTransitions.js.

export const MUSIC_VIDEO_IMAGE_EFFECTS = Object.freeze(['flash-develop', 'end-fade', 'end-flash', 'end-glitch']);

export const MUSIC_VIDEO_IMAGE_EFFECT_LABELS = Object.freeze({
  'flash-develop': 'Camera flash develop',
  'end-fade': 'Fade to end frame',
  'end-flash': 'Flash to end frame',
  'end-glitch': 'Glitch to end frame',
});

/** Effects that play from the start frame to the end frame. */
export const END_FRAME_IMAGE_EFFECTS = Object.freeze(['end-fade', 'end-flash', 'end-glitch']);
export const isEndFrameImageEffect = (effect) => END_FRAME_IMAGE_EFFECTS.includes(effect);

/** When an end-frame effect changes, in seconds into the shot; unset is the middle. */
export const IMAGE_EFFECT_CHANGE_SECS = Object.freeze([0.5, 1, 1.5, 2, 3, 4, 6]);

/** The develop lengths the shot card offers, in seconds. */
export const IMAGE_EFFECT_DEVELOP_SECS = Object.freeze([1, 2, 3, 4, 6, 8]);
export const DEFAULT_IMAGE_EFFECT_SEC = 3;
export const IMAGE_EFFECT_SEC_RANGE = Object.freeze({ min: 0.5, max: 30 });

export const PHOTO_SEQUENCE_LIMIT = 16;
export const PHOTO_SEQUENCE_DEFAULT_FRAMES = 6;
export const PHOTO_SEQUENCE_RATES = Object.freeze(['frames', 'beat', 'half']);

/** Compile a still's photo changes onto the absolute song-frame grid. */
export function scenePhotoSequence(scene, { fps = 24, beats = [] } = {}) {
  const sequence = scene?.photoSequence;
  if (scene?.visualLayer !== 'still' || !sequence || sequence.enabled === false) return null;
  const startFrame = Math.round((scene.startSec || 0) * fps);
  const intervalFrames = sequence.intervalFrames || PHOTO_SEQUENCE_DEFAULT_FRAMES;
  const rate = PHOTO_SEQUENCE_RATES.includes(sequence.rate) ? sequence.rate : 'frames';
  const grid = [...new Set((Array.isArray(beats) ? beats : []).filter(Number.isFinite))].sort((a, b) => a - b);
  const points = rate === 'half' ? grid.flatMap((b, i) => i + 1 < grid.length ? [b, (b + grid[i + 1]) / 2] : [b]) : grid;
  const switchFrames = rate !== 'frames' && grid.length
    ? [...new Set(points.map(t => Math.round(t * fps) - startFrame).filter(f => f > 0 && f < Math.round((scene.endSec || 0) * fps) - startFrame))]
    : null;
  return { imageIds: sequence.imageIds || [], intervalFrames, rate, startFrame, switchFrames };
}

/** Pure selection at song time; shared by scrubbing, Canvas and ffmpeg planning. */
export function photoSequenceIndex(sequence, t, { fps = 24 } = {}) {
  const frame = Math.max(0, Math.floor(t * fps + 1e-6) - sequence.startFrame);
  let step = Math.floor(frame / sequence.intervalFrames);
  if (sequence.switchFrames) {
    let lo = 0; let hi = sequence.switchFrames.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sequence.switchFrames[mid] <= frame) lo = mid + 1;
      else hi = mid;
    }
    step = lo;
  }
  return step % Math.max(1, sequence.imageIds.length);
}

// The flash fades from full white to nothing over this long.
const FLASH_SEC = 0.25;
// The undeveloped emulsion's colour, and the share of the develop it takes to clear.
export const IMAGE_EFFECT_FOG_COLOR = '#4a5452';
const FOG_SHARE = 0.75;
// Contrast starts here and rises to 1 as the picture develops.
const START_CONTRAST = 0.55;
// The dissolve to the end frame takes this long; the end frame's flash rises over
// FLASH_UP_SEC to full white on the cut and fades over FLASH_SEC after it.
const FADE_SEC = 0.6;
const FLASH_UP_SEC = 0.08;
// The glitch an end-frame glitch plays on its cut (musicVideoTransitions.js).
export const IMAGE_EFFECT_GLITCH_STYLE = 'vhs-glitch';

const isEffect = (value) => MUSIC_VIDEO_IMAGE_EFFECTS.includes(value);
const clampSec = (sec) => Math.min(IMAGE_EFFECT_SEC_RANGE.max, Math.max(IMAGE_EFFECT_SEC_RANGE.min, sec));

/**
 * The effect a scene plays, `{ effect, developSec }` (an end-frame effect:
 * `{ effect, changeSec }`), or null. Only a still shot in a layered
 * composition plays one, and an end-frame effect needs the shot's end frame:
 * anywhere else the shot shows its footage or still as before.
 */
export function sceneImageEffect(scene, { layered = false } = {}) {
  if (!layered || scene?.visualLayer !== 'still' || !isEffect(scene?.imageEffect)) return null;
  const sec = Number(scene.imageEffectSec);
  const set = Number.isFinite(sec) && sec > 0;
  if (!isEndFrameImageEffect(scene.imageEffect)) return { effect: scene.imageEffect, developSec: set ? clampSec(sec) : DEFAULT_IMAGE_EFFECT_SEC };
  if (!scene.endImageId) return null;
  const spanSec = typeof scene.startSec === 'number' && typeof scene.endSec === 'number' ? scene.endSec - scene.startSec : null;
  const middle = spanSec != null && spanSec > 0 ? spanSec / 2 : DEFAULT_IMAGE_EFFECT_SEC;
  return { effect: scene.imageEffect, changeSec: set && (spanSec == null || sec < spanSec) ? sec : Math.round(middle * 1000) / 1000 };
}

/** The frame (from the shot's first, at `fps`) an end-frame effect cuts or starts dissolving on. */
export const imageEffectChangeFrame = (effectSpec, fps) => Math.max(0, Math.round(effectSpec.changeSec * fps));

const ramp = (tSec, sec) => Math.min(1, Math.max(0, tSec / sec));

/**
 * The effect's state `tSec` seconds into the shot: `flash` and `fog` are the
 * opacities of the white flash and the emulsion colour over the picture,
 * `contrast` / `saturation` the picture's own (1 = as shot), and `end` the end
 * frame's opacity over the start frame. A cut lands on a frame of `fps`.
 */
export function imageEffectState(effectSpec, tSec, { fps = 24 } = {}) {
  const { effect, developSec } = effectSpec;
  const clean = { flash: 0, fog: 0, contrast: 1, saturation: 1, end: 0 };
  const t = Math.max(0, tSec);
  if (isEndFrameImageEffect(effect)) {
    const changeAt = imageEffectChangeFrame(effectSpec, fps) / fps;
    if (effect === 'end-fade') return { ...clean, end: ramp(t - changeAt, FADE_SEC) };
    const cut = t >= changeAt - 1e-6 ? 1 : 0;
    if (effect === 'end-glitch') return { ...clean, end: cut };
    return { ...clean, end: cut, flash: cut ? 1 - ramp(t - changeAt, FLASH_SEC) : ramp(t - (changeAt - FLASH_UP_SEC), FLASH_UP_SEC) };
  }
  if (effect !== 'flash-develop') return clean;
  const progress = ramp(t, developSec);
  return {
    flash: 1 - ramp(t, FLASH_SEC),
    fog: 1 - ramp(t, developSec * FOG_SHARE),
    contrast: START_CONTRAST + (1 - START_CONTRAST) * progress,
    saturation: progress * progress,
    end: 0,
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
 * An end-frame effect reads the end frame from `end`, a labelled stream the
 * caller prepared like the still (cover-fitted, moved, trimmed). Its glitch
 * frames are painted with the cut transitions' (`imageEffectGlitchFrames` in
 * musicVideoTransitions.js).
 */
export function musicVideoImageEffectFilter(effectSpec, { width, height, fps, key, atSec = 0, end = null }) {
  const startFrame = Math.max(0, atSec) * fps;
  if (isEndFrameImageEffect(effectSpec?.effect)) {
    if (!end) return '';
    // The change, counted from this section's first frame.
    const change = imageEffectChangeFrame(effectSpec, fps) - Math.round(startFrame);
    if (effectSpec.effect === 'end-fade') {
      const frames = Math.max(1, Math.round(FADE_SEC * fps));
      // The dissolve by frame number, so a piece starting mid-dissolve picks it up where it stands.
      const mix = `clip((N-(${change}))/${frames},0,1)`;
      return `[fxa${key}];[fxa${key}]format=yuv420p[fxs${key}];[${end}]format=yuv420p[fxb${key}];`
        + `[fxs${key}][fxb${key}]blend=all_expr='A+(B-A)*${mix}':shortest=1,format=yuv420p`;
    }
    let chain = `[fxa${key}];[fxa${key}][${end}]overlay=shortest=1:format=auto:enable='gte(n,${change})'`;
    if (effectSpec.effect === 'end-flash') {
      const up = Math.max(1, Math.round(FLASH_UP_SEC * fps));
      const down = Math.max(1, Math.round(FLASH_SEC * fps));
      const rise = change - up;
      const fades = [
        ...(change > 0 ? [`fade=t=in:start_frame=${Math.max(0, rise)}:nb_frames=${Math.min(up, change)}:alpha=1`] : []),
        ...(change + down > 0 ? [`fade=t=out:start_frame=${Math.max(0, change)}:nb_frames=${change >= 0 ? down : change + down}:alpha=1`] : []),
      ];
      // Before its rise the flash layer is clear; from the cut it fades to nothing,
      // from where it stands when a piece starts mid-fade.
      if (change + down > 0) {
        chain += `[fxcut${key}];color=c=white@${num(change >= 0 ? 1 : (change + down) / down)}:s=${width}x${height}:r=${fps},format=yuva420p,${fades.join(',')}[fxflash${key}];`
          + `[fxcut${key}][fxflash${key}]overlay=shortest=1:format=auto`;
      }
    }
    return `${chain},format=yuv420p`;
  }
  if (effectSpec?.effect !== 'flash-develop') return '';
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
