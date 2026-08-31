/**
 * Register the additive FableLoom production provenance shape.
 *
 * Existing looms need no rewrite: the record sanitizer preserves the optional
 * per-asset conditioning map, while new renders populate it as they complete.
 * The fableLoom schema-version gate still advances so a peer that cannot retain
 * typed playback provenance pauses federation instead of round-tripping it away.
 */

export default {
  async up() {
    console.log('🧶 FableLoom production provenance: additive playback fields are lazy-populated; no existing-record rewrite required');
  },
};
