/**
 * Re-export shim. The effective-track store moved to
 * `lib/spriteAnimationTrackStore.js` so the sprite route schemas can stay
 * module-load constants without importing upward into services (issue #4901).
 * It reads one small JSON config through lib/fileUtils and depends on no
 * service. Existing deep imports keep working.
 */

export * from '../../lib/spriteAnimationTrackStore.js';
