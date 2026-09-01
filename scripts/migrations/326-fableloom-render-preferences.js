/**
 * Register additive FableLoom image/video render preferences.
 *
 * Existing stories need no eager rewrite: the render-preference normalizer
 * supplies null defaults on read until an author saves a story-level pin, and
 * the next ordinary write persists the expanded render-settings shape. The
 * federation schema gate advances separately so older peers cannot round-trip
 * the preferences away during an unrelated whole-record update.
 */

export default {
  async up() {
    console.log('🧶 FableLoom render preferences: existing stories keep provider defaults until a story pin is saved');
  },
};
