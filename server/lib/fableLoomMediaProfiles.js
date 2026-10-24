/** Version changes invalidate cached encodes when the recipe changes. */
export const FABLELOOM_MEDIA_PROFILES = Object.freeze({
  source: Object.freeze({ id: 'source', version: 1 }),
  'web-720p': Object.freeze({ id: 'web-720p', version: 1, width: 1280, height: 720,
    videoKbps: 2000, audioKbps: 128, fps: 30, integratedLufs: -16, truePeakDb: -1.5, loudnessRange: 11 }),
  'web-1080p': Object.freeze({ id: 'web-1080p', version: 1, width: 1920, height: 1080,
    videoKbps: 4000, audioKbps: 192, fps: 30, integratedLufs: -16, truePeakDb: -1.5, loudnessRange: 11 }),
});
