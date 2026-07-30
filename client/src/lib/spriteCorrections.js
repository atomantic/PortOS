/**
 * Sprite correction-note keys + request fragment (#2964, extended to every
 * regeneration surface by #3134).
 *
 * Every Sprite Manager surface that can re-roll a render — the turnaround sheet,
 * the main reference, the 7 directional anchors, and each animation track's
 * reference + clips (`walk` plus whatever the user's registry holds) — writes
 * its note into ONE page-owned
 * `corrections` map (lifted to `Sprites.jsx`). This module owns that map's key
 * vocabulary and the single helper that turns a note into a request fragment, so
 * the pure action-gating layer (`spriteCollectionActions.js`) and the React
 * surfaces (`CorrectionNote.jsx` and its hosts) agree without the pure layer
 * having to import a component.
 *
 * ## Why keys are namespaced per SURFACE, not per direction
 *
 * An anchor note ("no pocket on the right sleeve" — a still-image fix) must not
 * silently ride the next walk-VIDEO re-roll for the same direction, and vice
 * versa. The anchors keep the bare direction key so pre-#3134 behavior and state
 * are untouched; every other surface prefixes.
 *
 * Pure — no React, no I/O.
 */

/** The 7 turnaround-derived anchors keep the bare direction key (pre-#3134). */
export const anchorCorrectionKey = (direction) => direction;
/** The frozen main/south reference — one per record, so no direction in the key. */
export const MAIN_CORRECTION_KEY = 'main';
/** The walk-cycle video for a direction — shared by WalkWorkflow and the asset card. */
export const walkCorrectionKey = (direction) => `walk:${direction}`;
/**
 * Any non-walk animation track's clip, for one facing (#3136).
 *
 * Replaces the per-track keys (`scanner:<dir>`, `ambient-loop`) each surface used
 * to spell by hand, so a user-defined track's note gets a namespaced key with
 * nothing to add here. The facing is part of the key for the same reason it is
 * for walk: a directional track's clips are separate re-rolls, and a note about
 * one must not ride the next; a non-directional track's single row resolves to
 * one value.
 *
 * Deliberately NOT byte-compatible with the two old keys — `corrections` is
 * transient page state (typed in this session, never persisted), so there is no
 * stored note to migrate.
 */
export const trackCorrectionKey = (trackId, direction) => `${trackId}:${direction}`;
/** A place/object's at-rest identity still. */
export const AMBIENT_REFERENCE_CORRECTION_KEY = 'ambient-reference';

/**
 * Build the re-roll request fragment for one correction key. Returns
 * `{ correctionPrompt }` only when the note is non-empty after trimming, else
 * `{}` — so an absent or whitespace-only note is omitted from the request,
 * matching the server's optional `correctionPrompt` and keeping a blind
 * regenerate byte-identical. EVERY re-roll surface spreads this, so they all
 * send identical payloads — the single source guarantee at the request layer,
 * not just the input layer.
 */
export function correctionPromptPayload(corrections, key) {
  const note = corrections?.[key]?.trim();
  return note ? { correctionPrompt: note } : {};
}
