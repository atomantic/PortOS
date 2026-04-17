// Static Kokoro voice catalogue — mirrors the frozen `$` table inside
// kokoro-js's bundled dist (kokoro-js@^1.2.x), which the package does not
// export at the top level. We use this for `listVoices()` so the UI can
// populate a picker without paying the 80MB model load.
// Refresh from node_modules/kokoro-js/dist/kokoro.js when bumping the dep.

export const KOKORO_VOICES = Object.freeze({
  af_heart:    { gender: 'Female', language: 'en-US', traits: '❤️', grade: 'A' },
  af_alloy:    { gender: 'Female', language: 'en-US', grade: 'C' },
  af_aoede:    { gender: 'Female', language: 'en-US', grade: 'C+' },
  af_bella:    { gender: 'Female', language: 'en-US', traits: '🔥', grade: 'A-' },
  af_jessica:  { gender: 'Female', language: 'en-US', grade: 'D' },
  af_kore:     { gender: 'Female', language: 'en-US', grade: 'C+' },
  af_nicole:   { gender: 'Female', language: 'en-US', traits: '🎧', grade: 'B-' },
  af_nova:     { gender: 'Female', language: 'en-US', grade: 'C' },
  af_river:    { gender: 'Female', language: 'en-US', grade: 'D' },
  af_sarah:    { gender: 'Female', language: 'en-US', grade: 'C+' },
  af_sky:      { gender: 'Female', language: 'en-US', grade: 'C-' },
  am_adam:     { gender: 'Male',   language: 'en-US', grade: 'F+' },
  am_echo:     { gender: 'Male',   language: 'en-US', grade: 'D' },
  am_eric:     { gender: 'Male',   language: 'en-US', grade: 'D' },
  am_fenrir:   { gender: 'Male',   language: 'en-US', grade: 'C+' },
  am_liam:     { gender: 'Male',   language: 'en-US', grade: 'D' },
  am_michael:  { gender: 'Male',   language: 'en-US', grade: 'C+' },
  am_onyx:     { gender: 'Male',   language: 'en-US', grade: 'D' },
  am_puck:     { gender: 'Male',   language: 'en-US', grade: 'C+' },
  am_santa:    { gender: 'Male',   language: 'en-US', grade: 'D-' },
  bf_alice:    { gender: 'Female', language: 'en-GB', grade: 'D' },
  bf_emma:     { gender: 'Female', language: 'en-GB', grade: 'B-' },
  bf_isabella: { gender: 'Female', language: 'en-GB', grade: 'C' },
  bf_lily:     { gender: 'Female', language: 'en-GB', grade: 'D' },
  bm_daniel:   { gender: 'Male',   language: 'en-GB', grade: 'D' },
  bm_fable:    { gender: 'Male',   language: 'en-GB', grade: 'C' },
  bm_george:   { gender: 'Male',   language: 'en-GB', grade: 'C' },
  bm_lewis:    { gender: 'Male',   language: 'en-GB', grade: 'D+' },
});
