/**
 * Quota-burn dispatch-cap sentinel — the `maxDispatchesPerWindow` value meaning
 * the window is not counted at all. -1 rather than 0/null: it stays a number for
 * the client's `<input type="number">` and the run log, and it can never be
 * confused with "0 burns allowed" (which is what disabling the family means).
 * Any negative cap reads as unlimited.
 *
 * A leaf module (no imports) so the client's quota-burn form and the server
 * normalizer share one definition. `quotaBurnConfig.js` re-exports these.
 */
export const QUOTA_BURN_UNLIMITED_DISPATCHES = -1;

export const isUnlimitedDispatchCap = (cap) => Number(cap) < 0;
