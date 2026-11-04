// Dependency-free reference ceilings. Schema-only callers (request validation)
// read these without instantiating the image-capability and reference-selection
// modules that own the behavior around them.

// Wire ceiling for explicit reference slots; individual backends can be lower.
export const IMAGE_REFERENCE_REQUEST_LIMIT = 16;

/** Research photos one music-video shot holds (scene.researchReferences, #14822). */
export const MUSIC_VIDEO_RESEARCH_REFERENCE_LIMIT = 6;
