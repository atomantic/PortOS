/**
 * The Length Profile picker's client-side helpers, over the issue-length
 * vocabulary in `server/lib/issueLength.js`.
 *
 * The profile table and the custom-override bounds are re-exported from the
 * server leaf rather than copied: the same profile drives the picker chip and
 * the server-side target computation, so a bound changed on one side cannot
 * leave the form offering a value the server clamps. `clampInt` and
 * `summarizeLengthProfile` are client-only form/display helpers with no server
 * twin (the server's private clamp has a different empty-input contract).
 */
import { DEFAULT_LENGTH_PROFILE, LENGTH_PROFILES } from '../../../server/lib/issueLength.js';

export {
  CUSTOM_MINUTE_MAX,
  CUSTOM_MINUTE_MIN,
  CUSTOM_PAGE_MAX,
  CUSTOM_PAGE_MIN,
  DEFAULT_LENGTH_PROFILE,
  LENGTH_PROFILES,
} from '../../../server/lib/issueLength.js';

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
