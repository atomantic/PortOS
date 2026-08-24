/**
 * Re-export shim. The animation-track registry moved to
 * `lib/spriteAnimationTracks.js` — a zero-import table of constants that route
 * validation reads directly (issue #4901). Existing deep imports keep working.
 */

export * from '../../lib/spriteAnimationTracks.js';
