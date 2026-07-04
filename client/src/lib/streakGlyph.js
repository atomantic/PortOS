/**
 * The single POST streak glyph used across the launcher, Morse trainer, daily
 * widget, and dashboard streak widget — one implementation instead of the four
 * copy-pasted ternaries that used to drift (issue #2091).
 *
 * ✨ under 3 days, ⚡ at 3–6, 🔥 at 7+.
 */
export function streakGlyph(streak) {
  return streak >= 7 ? '🔥' : streak >= 3 ? '⚡' : '✨';
}
