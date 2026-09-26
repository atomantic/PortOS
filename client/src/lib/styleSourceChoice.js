/**
 * Mood-board choice sentinels shared by every universe/mood-board style picker
 * (`components/media/UniverseMoodBoardPicker.jsx`): follow the universe's
 * linked board, or none. Form-only values — each surface maps them onto its
 * own wire contract. Code Animation persists them in saved drafts, so the
 * values are frozen. Pure and DOM-free so node-side parity tests can import
 * the commission form helpers that use it.
 */
export const BOARD_FOLLOW_UNIVERSE = 'universe';
export const BOARD_NONE = 'none';
