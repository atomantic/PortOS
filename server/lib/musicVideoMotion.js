/**
 * Music Video motion-prompt constants shared by the server (handoff.js
 * sceneShotPrompt, the production run) and the client board.
 *
 * An i2v model drifts toward daylight and a new palette over a 5–10 s take
 * when the motion prompt does not pin them (a night rooftop turned overcast
 * mid-shot in a real run), so every motion prompt ends with this clause.
 */
export const MOTION_CONTINUITY_CLAUSE = "hold the reference frame's lighting, time of day and palette for the whole shot";
