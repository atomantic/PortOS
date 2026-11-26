/** Blender model review looks and fixed orthographic camera angles in sheet order. */

export const BLENDER_MODEL_REVIEW_LOOKS = Object.freeze(['textured', 'clay']);

/** The fixed views, in sheet order; all orthographic and at one scale. */
export const BLENDER_MODEL_FIXED_VIEWS = Object.freeze({
  front: { azimuth: 0, elevation: 0 },
  right: { azimuth: 90, elevation: 0 },
  back: { azimuth: 180, elevation: 0 },
  left: { azimuth: 270, elevation: 0 },
  top: { azimuth: 0, elevation: 90 },
  bottom: { azimuth: 0, elevation: -90 },
  'three-quarter': { azimuth: 35, elevation: 25 },
});
