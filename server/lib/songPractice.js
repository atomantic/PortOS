/**
  * SongBook practice scheduling: the pure core behind `POST /api/brain/songbook/:id/practice` (#4102).
  *
  * A song's `stage` (`new → learning → learned → memorized`) was manual in v1; logging a session now grades the run 0..5 and from that advances the SM-2 schedule (shared with MeatSpace POST via `lib/spacedRepetition.js`) and advances or regresses the stage. The schedule lives on the song record as `practice`: the shared four-field schedule plus `sessions` and `lastQuality` counters. It is SERVER-MANAGED like `attachments` (write schemas have no key, so Zod's unknown-key stripping drops a client value; an SM-2 advance needs the stored schedule so it can't be a plain PATCH: it would race and push the scheduler into the browser). Compatibility (songs federate raw between installs, LWW, no Zod on receive, each upgrading on its own schedule): `practice` is purely ADDITIVE and absent on songs predating this; `songPracticeOrDefault` derives one on READ anchored to the song's `updatedAt`/`createdAt`, nothing backfilled (a migration would rewrite every song on every peer, restamp `updatedAt`, spray churn across the federation, and break the `data.reference/` seeds' byte-identity). An unrecognized `stage` from a newer peer is left ALONE (`nextSongStage` no-ops on it) so a practice log can't rewrite a value this install doesn't understand.
 */

import {
  advanceSchedule,
  isSameReviewDay,
  isScheduleDue,
  mergeScheduleAdvance,
  qualityToRatio,
  scheduleOrDefault,
} from './spacedRepetition.js';

/** The stage ladder, in order; mirrors `songStageEnum` in brainValidation.js and `SONG_STAGES` in client/src/components/songbook/constants.js (parity asserted on both sides). */
export const SONG_STAGE_ORDER = Object.freeze(['new', 'learning', 'learned', 'memorized']);

/** Grade at or above which a session promotes the song one stage: 4 = "solid, with hesitation" on the SM-2 scale (you can play it, not merely got through it). */
export const SONG_PROMOTE_MIN_QUALITY = 4;
/** Grade at or below which a session regresses one stage: 2 = "wrong, but it came back once you saw it"; a 3 holds the stage (a shaky-but-complete run is no evidence of movement). */
export const SONG_REGRESS_MAX_QUALITY = 2;

/** The lowest stage a PRACTICED song regresses to: `new` ("never picked up") stops being true on logging a session, so a bad run drops to `learning`, never `new` (a bad first session on a `new` song moves it FORWARD to `learning`). */
const MIN_PRACTICED_STAGE_INDEX = 1;

/** The song's practice schedule as it should be READ, without persisting: absent/malformed → a default anchored to the song so an unpracticed song reads as due now and two reads a millisecond apart agree. */
export function songPracticeOrDefault(song) {
  return scheduleOrDefault(song, song?.practice);
}

/** Is this song due for practice at `now`? Never-practiced songs are due. */
export function isSongDue(song, now = new Date()) {
  return isScheduleDue(songPracticeOrDefault(song), now);
}

/**
 * The stage a session graded `quality` moves `stage` to. `allowPromotion: false` holds the stage on a good run (a second session the same day is one day of progress, like interval growth gating); a regression is never gated.
 * An unknown stage (synced from a newer peer) is returned unchanged.
 */
export function nextSongStage(stage, quality, { allowPromotion = true } = {}) {
  const index = SONG_STAGE_ORDER.indexOf(stage);
  if (index === -1) return stage;
  if (quality <= SONG_REGRESS_MAX_QUALITY) {
    return SONG_STAGE_ORDER[Math.max(MIN_PRACTICED_STAGE_INDEX, index - 1)];
  }
  if (allowPromotion && quality >= SONG_PROMOTE_MIN_QUALITY) {
    return SONG_STAGE_ORDER[Math.min(SONG_STAGE_ORDER.length - 1, index + 1)];
  }
  return stage;
}

/** Log one practice session against `song`, graded `quality` (0..5). Pure: returns ONLY the fields to persist (`{ stage, practice }`) for `brainStorage.updateWith`'s locked read-modify-write. */
export function applySongPractice(song, quality, now = new Date(), timezone = 'UTC') {
  const previous = songPracticeOrDefault(song);
  const sameDay = isSameReviewDay(previous.lastReviewed, now, timezone);
  const advanced = advanceSchedule(previous, qualityToRatio(quality), now);
  const schedule = mergeScheduleAdvance(previous, advanced, now, timezone);
  const sessions = Number.isInteger(previous.sessions) ? previous.sessions : 0;

  return {
    stage: nextSongStage(song?.stage || 'new', quality, { allowPromotion: !sameDay }),
    practice: { ...schedule, sessions: sessions + 1, lastQuality: quality },
  };
}
