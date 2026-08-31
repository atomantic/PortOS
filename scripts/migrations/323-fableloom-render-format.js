/**
 * Register the additive FableLoom render-format pin.
 *
 * Existing records need no eager rewrite: sanitizeLoom backfills the explicit
 * 16:9 landscape default on read, and the next ordinary write persists it.
 * The federation schema gate advances separately so an older peer cannot
 * round-trip a chosen format away.
 */

export default {
  async up() {
    console.log('🧶 FableLoom render format: existing stories default to explicit 16:9 landscape on read');
  },
};
