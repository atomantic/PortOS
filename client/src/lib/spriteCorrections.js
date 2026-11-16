/**
 * Sprite correction-note keys + the request fragment that carries a note (#2964, #3134).
 *
 * Every Sprite Manager surface that can re-roll a render writes its note into ONE page-owned `corrections` map (`Sprites.jsx`); this module owns its key vocabulary and the helper turning a note into a request fragment.
 * Keys are namespaced per SURFACE, not per direction (an anchor note, a still-image fix, must not ride the next walk-VIDEO re-roll). Anchors keep the bare direction key; every other surface prefixes. Pure: no React, no I/O.
 */

export const anchorCorrectionKey = (direction) => direction;
/** The frozen main/south reference — one per record, so no direction in the key. */
export const MAIN_CORRECTION_KEY = 'main';
export const walkCorrectionKey = (direction) => `walk:${direction}`;
/**
 * Any non-walk animation track's clip, for one facing (#3136): a user-defined track's note gets a namespaced key with nothing to add here. The facing is part of the key as for walk (a directional track's clips are separate re-rolls).
 * Not byte-compatible with the old keys: `corrections` is transient page state, so there is no stored note to migrate.
 */
export const trackCorrectionKey = (trackId, direction) => `${trackId}:${direction}`;
export const AMBIENT_REFERENCE_CORRECTION_KEY = 'ambient-reference';

/**
 * Build the re-roll request fragment for one correction key: `{ correctionPrompt }` only when the note is non-empty after trimming, else `{}`, matching the server's optional field and keeping a blind regenerate byte-identical.
 * EVERY re-roll surface spreads this, so they send identical payloads.
 */
export function correctionPromptPayload(corrections, key, { verbatim = false } = {}) {
  const raw = corrections?.[key];
  const note = verbatim ? raw : raw?.trim();
  return note ? { correctionPrompt: note } : {};
}
