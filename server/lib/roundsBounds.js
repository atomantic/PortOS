/**
 * Rounds tempo and part-count bounds shared by the server validator and the
 * client editor/metronome. A leaf module (no imports) so the browser bundle can
 * import it; `roundsValidation.js` re-exports these.
 */
export const TEMPO_MIN = 20;
export const TEMPO_MAX = 320;
export const PARTNERS_MAX = 12;        // partner-song ids (rounds sung together)
export const SCORE_PARTS_MAX = 12;     // harmony variations of the sheet music
