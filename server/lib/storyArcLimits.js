/** Canonical length and count caps for story arcs, seasons, and episodes. */
export const ARC_LIMITS = Object.freeze({
  LOGLINE_MAX: 500,
  SUMMARY_MAX: 8000,
  PROTAGONIST_ARC_MAX: 4000,
  THEME_MAX: 100,
  THEMES_PER_ARC_MAX: 20,
  SEASON_TITLE_MAX: 200,
  SEASON_LOGLINE_MAX: 500,
  // A season synopsis covers a whole season's worth of episodes (8+ issues on a
  // multi-season series), so it needs the same room as the arc-level SUMMARY_MAX
  // (8000). The old 4000 cap clipped a full synopsis mid-sentence — and because
  // the arc-verify→resolve loop re-flags a mid-sentence truncation and the
  // resolver regenerates a >4000 synopsis that gets re-clipped, the loop could
  // never converge (it burned all its rounds and paused). See arc-verify
  // "truncated mid-sentence" finding, 2026-06-21.
  SEASON_SYNOPSIS_MAX: 8000,
  SEASON_ENDING_HOOK_MAX: 1000,
  SEASON_NUMBER_MAX: 99,
  SEASON_EPISODE_COUNT_MAX: 999,
  SEASONS_PER_SERIES_MAX: 50,
  // One issue/episode planning synopsis. This is deliberately smaller than a
  // whole-volume synopsis: it is a drafting seed, not a place to accumulate
  // every continuity exception the verifier has ever raised. Keep the value in
  // the shared arc limits so initial episode generation and later arc repairs
  // cannot silently disagree about how much text one episode may own.
  EPISODE_LOGLINE_MAX: 500,
  EPISODE_SYNOPSIS_MAX: 4000,
});

// Shared authoring contract, also consumed by the Arc Canvas and API schema.
export const SERIES_DESIGN_MODES = Object.freeze(['finite', 'renewable']);
export const SERIES_DESIGN_TEXT_MAX = 1000;
export const SERIES_DESIGN_FIELDS = Object.freeze({
  episodeActivity: 'Episode activity',
  conflictSource: 'Conflict source',
  audiencePromise: 'Audience promise',
  continuingTensions: 'Continuing tensions',
  endingCondition: 'Ending condition',
});
