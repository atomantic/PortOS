/**
 * Client re-export of music-video image effects (camera flash developing over a still): effect labels,
 * develop lengths, and `sceneImageEffect`.
 *
 * Music-video image effects (a camera flash that develops over a still shot), re-exported from
 * `server/lib/musicVideo/musicVideoImageEffects.js`: the effects, labels and develop lengths, `sceneImageEffect`,
 * `imageEffectState`. Used by `components/musicVideo/SceneImageEffect.jsx` and the storyboard
 * animatic. Also exports the still-photo sequence limits, frame-grid compiler `scenePhotoSequence` and
 * absolute-time selector `photoSequenceIndex`.
 */

/**
 * Music Video image effects — re-export of `server/lib/musicVideo/musicVideoImageEffects.js`,
 * so the shot card's picker and the animatic paint the same effect as the final render.
 */
export { DEFAULT_IMAGE_EFFECT_SEC, IMAGE_EFFECT_CHANGE_SECS, IMAGE_EFFECT_DEVELOP_SECS, IMAGE_EFFECT_FOG_COLOR, MUSIC_VIDEO_IMAGE_EFFECTS, MUSIC_VIDEO_IMAGE_EFFECT_LABELS, DEFAULT_PHOTO_LAYOUT, PHOTO_LAYOUT_RANGES, PHOTO_SEQUENCE_LIMIT, PHOTO_SEQUENCE_OVERLAP_MAX_FRAMES, PHOTO_SEQUENCE_DEFAULT_FRAMES, scenePhotoSequence, photoSequenceIndex, photoSequenceLayers, photoSequenceMaxLayers, photoStackLayouts, imageEffectState, isEndFrameImageEffect, sceneImageEffect } from '../../../server/lib/musicVideo/musicVideoImageEffects.js';
