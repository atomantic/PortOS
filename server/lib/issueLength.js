/**
 * Issue length profiles — per-issue size targets fed into every text stage
 * prompt (idea / prose / comicScript / teleplay) so the LLM scales the beat
 * sheet, prose word count, comic page count, and TV runtime to match.
 *
 * Each issue stores a profile name; the lookup here materializes that into
 * the concrete numbers downstream templates need:
 *
 *   pageTarget       comic pages
 *   minutesTarget    TV episode runtime in minutes
 *   proseWordsMin    prose draft floor
 *   proseWordsMax    prose draft ceiling
 *   beatsMin         beat-sheet floor
 *   beatsMax         beat-sheet ceiling
 *
 * Presets are calibrated so prose words ≈ pages × 125 (the working ratio
 * for a comic adaptation where each page reads ~30 words of dialogue plus
 * ~80 words of described action). Beat count scales with prose volume.
 *
 * The 'custom' sentinel lets the user pin a page count and minute count
 * directly; the other targets are derived proportionally off the 'standard'
 * baseline so the upstream stages still have something concrete.
 */

export const LENGTH_PROFILES = Object.freeze({
  teaser: Object.freeze({
    label: 'Teaser',
    description: 'Short promo issue / web teaser — a single big beat, cliffhanger ending.',
    pageTarget: 8,
    minutesTarget: 10,
    proseWordsMin: 1100,
    proseWordsMax: 1600,
    beatsMin: 4,
    beatsMax: 6,
  }),
  standard: Object.freeze({
    label: 'Standard',
    description: 'Standard floppy comic / half-hour episode — the working default.',
    pageTarget: 22,
    minutesTarget: 24,
    proseWordsMin: 2500,
    proseWordsMax: 4000,
    beatsMin: 8,
    beatsMax: 12,
  }),
  extended: Object.freeze({
    label: 'Extended',
    description: 'Premiere or special-length issue — extra room for setup or set-piece beats.',
    pageTarget: 32,
    minutesTarget: 36,
    proseWordsMin: 4500,
    proseWordsMax: 6500,
    beatsMin: 12,
    beatsMax: 16,
  }),
  finale: Object.freeze({
    label: 'Finale',
    description: 'Season/series finale or annual — full-runtime climax with reveals and act-outs.',
    pageTarget: 44,
    minutesTarget: 48,
    proseWordsMin: 6500,
    proseWordsMax: 8500,
    beatsMin: 14,
    beatsMax: 20,
  }),
});

export const DEFAULT_LENGTH_PROFILE = 'standard';
export const LENGTH_PROFILE_NAMES = Object.freeze([
  ...Object.keys(LENGTH_PROFILES),
  'custom',
]);

// Working bounds for custom overrides. Keeps a typo from asking for a
// 5000-page comic and a 600-minute movie. Exported so the issue sanitizer,
// the Zod patch schema, and the client picker all clamp to the same range —
// otherwise the persisted value can drift past the values
// `computeIssueTargets` is willing to honor at render time.
export const CUSTOM_PAGE_MIN = 4;
export const CUSTOM_PAGE_MAX = 120;
export const CUSTOM_MINUTE_MIN = 4;
export const CUSTOM_MINUTE_MAX = 240;
const STANDARD_PAGES = LENGTH_PROFILES.standard.pageTarget;
const STANDARD_WORDS_MIN = LENGTH_PROFILES.standard.proseWordsMin;
const STANDARD_WORDS_MAX = LENGTH_PROFILES.standard.proseWordsMax;
const STANDARD_BEATS_MIN = LENGTH_PROFILES.standard.beatsMin;
const STANDARD_BEATS_MAX = LENGTH_PROFILES.standard.beatsMax;

const clampInt = (raw, min, max, fallback) => {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
};

/**
 * Return the materialized length targets for an issue. Handles:
 *  - missing/invalid profile → standard
 *  - one of the named presets → table lookup
 *  - 'custom' → uses issue.pageTarget / issue.minutesTarget, derives prose
 *    and beat ranges by scaling against the standard preset
 *
 * Always returns a fully-populated object so prompt templates can use the
 * fields unconditionally.
 */
export function computeIssueTargets(issue = {}) {
  const profile = LENGTH_PROFILE_NAMES.includes(issue.lengthProfile)
    ? issue.lengthProfile
    : DEFAULT_LENGTH_PROFILE;

  if (profile === 'custom') {
    const pages = clampInt(
      issue.pageTarget,
      CUSTOM_PAGE_MIN,
      CUSTOM_PAGE_MAX,
      LENGTH_PROFILES.standard.pageTarget,
    );
    const minutes = clampInt(
      issue.minutesTarget,
      CUSTOM_MINUTE_MIN,
      CUSTOM_MINUTE_MAX,
      LENGTH_PROFILES.standard.minutesTarget,
    );
    // Anchor prose + beat counts to the comic-page scale — that's what the
    // prose draft is sized to feed downstream.
    const scale = pages / STANDARD_PAGES;
    return {
      profile,
      label: 'Custom',
      pageTarget: pages,
      minutesTarget: minutes,
      proseWordsMin: Math.max(600, Math.round(STANDARD_WORDS_MIN * scale)),
      proseWordsMax: Math.max(1000, Math.round(STANDARD_WORDS_MAX * scale)),
      beatsMin: Math.max(3, Math.round(STANDARD_BEATS_MIN * scale)),
      beatsMax: Math.max(5, Math.round(STANDARD_BEATS_MAX * scale)),
    };
  }

  const preset = LENGTH_PROFILES[profile];
  return { profile, ...preset };
}
