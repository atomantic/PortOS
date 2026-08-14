/**
 * SongBook practice scheduling — the pure core behind `POST
 * /api/brain/songbook/:id/practice` (#4102).
 *
 * A repertoire song's `stage` (`new → learning → learned → memorized`) was
 * manual in SongBook v1: nothing moved it, and nothing told the user WHICH song
 * to pick up today. Logging a practice session now does both — it grades the
 * run 0..5 and, from that grade, advances the SM-2 schedule (shared with
 * MeatSpace POST via `lib/spacedRepetition.js`) and advances or regresses the
 * stage.
 *
 * ## Where the schedule lives
 *
 * On the song record as `practice`, carrying the shared four-field schedule
 * plus two song-local counters:
 *
 *   { ease, intervalDays, nextReview, lastReviewed, sessions, lastQuality }
 *
 * `practice` is SERVER-MANAGED, exactly like `attachments`: the write schemas
 * have no key for it, so Zod's unknown-key stripping drops a client-supplied
 * value and only the practice endpoint can move it. Computing an SM-2 advance
 * needs the stored schedule, so it could not be a plain PATCH anyway — that
 * would race, and would push the scheduler into the browser.
 *
 * ## Backward + forward compatibility (this matters — songs federate)
 *
 * Brain songs sync raw between installs (LWW, no Zod on receive), and every
 * install upgrades on its own schedule. So:
 *
 *   - `practice` is purely ADDITIVE and absent on every song that predates this
 *     feature. `songPracticeOrDefault` derives one on READ, anchored to the
 *     song's own `updatedAt`/`createdAt` — nothing is backfilled to disk. A
 *     backfill migration would rewrite every song record on every peer, restamp
 *     `updatedAt`, and spray that churn across the federation for a value the
 *     read path already computes. It would also break the `data.reference/`
 *     seeds' byte-identity (a seeded `nextReview` differs per install).
 *   - An unrecognized `stage` from a newer peer is left ALONE rather than
 *     snapped into this version's ladder (`nextSongStage` no-ops on it), so a
 *     practice log can't rewrite a value this install doesn't understand.
 */

import {
  advanceSchedule,
  isSameReviewDay,
  isScheduleDue,
  mergeScheduleAdvance,
  qualityToRatio,
  scheduleOrDefault,
} from './spacedRepetition.js';

/**
 * The stage ladder, in order. Mirrors `songStageEnum` in brainValidation.js and
 * `SONG_STAGES` in client/src/components/songbook/constants.js — parity is
 * asserted by the tests on both sides.
 */
export const SONG_STAGE_ORDER = Object.freeze(['new', 'learning', 'learned', 'memorized']);

/**
 * Grade at or above which a session promotes the song one stage. 4 = "solid,
 * with hesitation" on the SM-2 scale — the point where you'd say you can play
 * it, not merely that you got through it.
 */
export const SONG_PROMOTE_MIN_QUALITY = 4;
/**
 * Grade at or below which a session regresses one stage. 2 = "wrong, but it
 * came back once you saw it". A 3 holds the stage: a shaky-but-complete run is
 * evidence you're where you thought you were, not evidence of movement.
 */
export const SONG_REGRESS_MAX_QUALITY = 2;

/**
 * The lowest stage a PRACTICED song can regress to. `new` means "never picked
 * up", which stops being true the moment you log a session — so a bad run drops
 * you to `learning`, never back to `new`. (This is also why a bad first session
 * on a `new` song moves it FORWARD to `learning`: you have now started it.)
 */
const MIN_PRACTICED_STAGE_INDEX = 1;

/**
 * The song's practice schedule as it should be READ, without persisting
 * anything. Absent/malformed → a default anchored to the song itself, so an
 * unpracticed song reads as due now and two reads a millisecond apart agree.
 */
export function songPracticeOrDefault(song) {
  return scheduleOrDefault(song, song?.practice);
}

/** Is this song due for practice at `now`? Never-practiced songs are due. */
export function isSongDue(song, now = new Date()) {
  return isScheduleDue(songPracticeOrDefault(song), now);
}

/**
 * The stage a session graded `quality` moves `stage` to.
 *
 * `allowPromotion: false` holds the stage where it is on a good run — used for
 * a second session on a day that already had one, for the same reason interval
 * growth is gated: two run-throughs in one afternoon are one day of progress,
 * not two. A regression is never gated; a run that fell apart should show today
 * regardless of how the earlier one went.
 *
 * An unknown stage (a value synced from a newer peer) is returned unchanged.
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

/**
 * Log one practice session against `song`, graded `quality` (0..5).
 *
 * Pure — returns ONLY the fields to persist (`{ stage, practice }`), so the
 * caller can hand it straight to `brainStorage.updateWith` and let the locked
 * read-modify-write merge it over the freshest record.
 */
export function applySongPractice(song, quality, now = new Date()) {
  const previous = songPracticeOrDefault(song);
  const sameDay = isSameReviewDay(previous.lastReviewed, now);
  const advanced = advanceSchedule(previous, qualityToRatio(quality), now);
  const schedule = mergeScheduleAdvance(previous, advanced, now);
  const sessions = Number.isInteger(previous.sessions) ? previous.sessions : 0;

  return {
    stage: nextSongStage(song?.stage || 'new', quality, { allowPromotion: !sameDay }),
    practice: { ...schedule, sessions: sessions + 1, lastQuality: quality },
  };
}
