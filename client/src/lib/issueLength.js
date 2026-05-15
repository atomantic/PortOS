/**
 * Client-side mirror of `server/lib/issueLength.js` — kept in lock-step
 * with the server table. The client only needs the labels + headline
 * numbers (pages / minutes) for the header dropdown; the full prose-word
 * / beat-count derivation lives server-side where the prompts render.
 */

export const LENGTH_PROFILES = Object.freeze({
  teaser: Object.freeze({
    label: 'Teaser',
    description: 'Short promo issue / web teaser.',
    pageTarget: 8,
    minutesTarget: 10,
  }),
  standard: Object.freeze({
    label: 'Standard',
    description: 'Standard floppy / half-hour episode (default).',
    pageTarget: 22,
    minutesTarget: 24,
  }),
  extended: Object.freeze({
    label: 'Extended',
    description: 'Premiere / longer special.',
    pageTarget: 32,
    minutesTarget: 36,
  }),
  finale: Object.freeze({
    label: 'Finale',
    description: 'Season / series finale or annual.',
    pageTarget: 44,
    minutesTarget: 48,
  }),
});

export const DEFAULT_LENGTH_PROFILE = 'standard';

// Working bounds for custom overrides — mirrored from `server/lib/issueLength.js`
// (CUSTOM_PAGE_MIN / CUSTOM_PAGE_MAX / CUSTOM_MINUTE_MIN / CUSTOM_MINUTE_MAX).
// The client cannot import from the server, so these values are duplicated here
// manually. If you change the range on the server side, update this file too.
export const CUSTOM_PAGE_MIN = 4;
export const CUSTOM_PAGE_MAX = 120;
export const CUSTOM_MINUTE_MIN = 4;
export const CUSTOM_MINUTE_MAX = 240;

// Clamp + round + fallback. Returns `null` for non-finite input so callers
// can distinguish "user cleared the field" from "user typed nonsense".
// Empty string is treated as absent (not coerced to 0) so clearing a Custom
// number input returns null rather than being clamped up to the minimum.
export function clampInt(raw, min, max) {
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// Render a one-line summary for the header chip, e.g.
// "Standard · 22pg / 24min" or "Custom · 18pg / 20min".
export function summarizeLengthProfile(issue) {
  const profile = issue?.lengthProfile || DEFAULT_LENGTH_PROFILE;
  if (profile === 'custom') {
    const pages = Number.isFinite(issue?.pageTarget) ? issue.pageTarget : LENGTH_PROFILES.standard.pageTarget;
    const minutes = Number.isFinite(issue?.minutesTarget) ? issue.minutesTarget : LENGTH_PROFILES.standard.minutesTarget;
    return { label: 'Custom', detail: `${pages}pg / ${minutes}min` };
  }
  const preset = LENGTH_PROFILES[profile] || LENGTH_PROFILES.standard;
  return { label: preset.label, detail: `${preset.pageTarget}pg / ${preset.minutesTarget}min` };
}
