/**
 * Re-export shim. The chroma-key color math moved to `lib/spriteChromaKey.js`
 * so route validation can read `CHROMA_KEY_HEXES` without importing upward into
 * services (issue #4901). The module always described itself as "pure … safe to
 * import anywhere"; lib is where that belongs. Existing deep imports keep working.
 */

export * from '../../lib/spriteChromaKey.js';
