// Preserves season locks and reconciles season and issue identities across arc rewrites.

import { ServerError } from '../../../lib/errorHandler.js';
import { stripAnsi } from '../../../lib/ansiStrip.js';
import { ARC_LOCKABLE_FIELDS, getSeries, updateSeries } from '../series.js';
import { listIssues, recomputeIssueNumbersForSeries, updateIssue } from '../issues.js';
import { emitRecordUpdated, withReexportSuppressed } from '../../sharing/recordEvents.js';
import { sanitizeSeasonList } from '../../../lib/storyArc.js';
import { ERR_VALIDATION } from './context.js';

// Preserve per-field arc locks. When `currentSeries.locked.arcFields[k]` is
// true, the incoming arc's value for `k` is replaced with the existing one so
// auto-resolve / regenerate flows can rewrite unlocked fields without
// clobbering user-frozen ones. `null` next-arc (no incoming arc) is passed
// through unchanged — the persist layer's sanitizer drops it.
export function mergeArcWithLocks(currentArc, nextArc, lockedFields) {
  if (!nextArc || !lockedFields || typeof lockedFields !== 'object') return nextArc;
  if (!currentArc) return nextArc;
  const merged = { ...nextArc };
  for (const field of ARC_LOCKABLE_FIELDS) {
    if (lockedFields[field] === true) merged[field] = currentArc[field];
  }
  return merged;
}

// Preserve per-season locks. For every locked season in `currentSeasons`:
//   - if the LLM proposed an entry with the same id, replace it with the
//     existing locked record field-for-field (LLM's title/logline/etc. are
//     discarded);
//   - if the LLM dropped it entirely, re-insert it so it survives the resolve.
// Unlocked seasons (and brand-new entries the LLM minted) pass through. The
// caller still funnels the result through `sanitizeSeasonList`, which re-sorts
// by `number` ascending and dedups by id.
//
// Mirrors `mergeArcWithLocks`'s contract: locks are an *enforcement* gate, not
// a workflow signal — the arc-level `series.locked.arc` check up the stack
// remains the all-or-nothing block; this lets users freeze individual seasons
// while still letting auto-resolve rewrite the rest of the arc.
export function mergeSeasonsWithLocks(currentSeasons, nextSeasons) {
  if (!Array.isArray(nextSeasons)) return nextSeasons;
  if (!Array.isArray(currentSeasons)) return nextSeasons;
  const lockedById = new Map();
  for (const s of currentSeasons) {
    if (s?.locked === true && s.id) lockedById.set(s.id, s);
  }
  if (lockedById.size === 0) return nextSeasons;
  const seen = new Set();
  const merged = [];
  for (const next of nextSeasons) {
    const locked = next?.id ? lockedById.get(next.id) : null;
    if (locked) {
      merged.push(locked);
      seen.add(locked.id);
    } else {
      merged.push(next);
    }
  }
  for (const [id, locked] of lockedById) {
    if (!seen.has(id)) merged.push(locked);
  }
  return merged;
}

// Re-insert every EXISTING season the rewrite dropped, without freezing the
// ones it kept. Distinct from `mergeSeasonsWithLocks`: that one restores a
// locked season's CONTENT verbatim (the user froze it); this one only
// guarantees the record survives, so a same-id rewrite still applies in full.
//
// Used by the autopilot's `unlockForRun` mode — once that pass clears the
// per-season locks, nothing else stops an LLM-proposed arc from silently
// deleting a volume, and unlocking for EDITING must not become a licence to
// DELETE (see seriesAutopilot/unlockPass.js).
//
// The preserved records go FIRST, and that ordering is load-bearing rather than
// cosmetic: `sanitizeSeasonList` caps the list at SEASONS_PER_SERIES_MAX by
// keeping the first N it sees. Appending them would mean an LLM that returned a
// full cap's worth of brand-new volumes silently pushed every existing volume
// past the cap — the sanitizer would drop them and `commitSeasonsWithRemap`
// would then treat them as deleted and reassign their issues, which is exactly
// the deletion this helper exists to refuse. Existing records therefore win the
// cap; the rewrite's surplus new volumes are what gets trimmed. Final display
// order is unaffected — `sanitizeSeasonList` sorts by `number` at the end.
export function preserveDroppedSeasonRecords(currentSeasons, nextSeasons) {
  if (!Array.isArray(nextSeasons)) return nextSeasons;
  if (!Array.isArray(currentSeasons)) return nextSeasons;
  const keptIds = new Set(nextSeasons.map((s) => s?.id).filter(Boolean));
  const dropped = currentSeasons.filter((s) => s?.id && !keptIds.has(s.id));
  return dropped.length === 0 ? nextSeasons : [...dropped, ...nextSeasons];
}

// Normalized title comparison, shared by the two season matchers below.
const normTitle = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

/**
 * Resolve each LLM-proposed season to the EXISTING season record it is a
 * rewrite of, so a rewrite lands on that record instead of minting a sibling.
 * Returns an array parallel to `proposedSeasons` holding the matched existing
 * season (or `null` when the proposal is genuinely new).
 *
 * Match priority mirrors `buildSeasonRemap`, and runs as three ordered passes
 * rather than one greedy sweep so a proposal that DOES carry an `id` always
 * wins its own record: a same-titled sibling processed earlier must not claim
 * it and push the id-carrying proposal into minting a duplicate.
 *   1. explicit `id`
 *   2. normalized title (the resolve prompt is told to preserve titles)
 *   3. `number`, only when exactly one unclaimed existing season has it
 *
 * Deliberately NOT a positional fallback — unlike `buildSeasonRemap`'s 1↔1
 * pass, a wrong guess here doesn't just misfile child issues, it overwrites a
 * volume's prose with another volume's rewrite. Unmatched proposals mint, which
 * is the recoverable outcome.
 */
export function matchProposedSeasons(existingSeasons, proposedSeasons) {
  const existing = Array.isArray(existingSeasons) ? existingSeasons.filter((s) => s?.id) : [];
  const proposed = Array.isArray(proposedSeasons) ? proposedSeasons : [];
  const matched = new Array(proposed.length).fill(null);
  if (existing.length === 0) return matched;
  const byId = new Map(existing.map((s) => [s.id, s]));
  const claimed = new Set();

  const claim = (idx, season) => {
    matched[idx] = season;
    claimed.add(season.id);
  };

  // Pass 1 — explicit id.
  proposed.forEach((raw, idx) => {
    const hit = raw?.id ? byId.get(raw.id) : null;
    if (hit && !claimed.has(hit.id)) claim(idx, hit);
  });

  // Pass 2 — normalized title.
  proposed.forEach((raw, idx) => {
    if (matched[idx]) return;
    const title = normTitle(raw?.title);
    if (!title) return;
    const hit = existing.find((s) => normTitle(s.title) === title && !claimed.has(s.id));
    if (hit) claim(idx, hit);
  });

  // Pass 3 — unambiguous `number`.
  proposed.forEach((raw, idx) => {
    if (matched[idx]) return;
    if (!Number.isFinite(raw?.number)) return;
    const hits = existing.filter((s) => s.number === raw.number && !claimed.has(s.id));
    if (hits.length === 1) claim(idx, hits[0]);
  });

  return matched;
}

// Prose fields a collapse may back-fill onto the surviving record. Only ever
// used to fill a field that is EMPTY on the survivor — never to overwrite.
const SEASON_FILLABLE_FIELDS = ['logline', 'synopsis', 'endingHook'];

// Rescue content that only exists on the records being absorbed, so collapsing
// a duplicate can't silently delete the one revision that had a synopsis.
function backfillSeasonGaps(survivor, group) {
  // Newest first — if several duplicates could fill a gap, the latest rewrite
  // is the one the user last saw.
  const donors = group
    .filter((s) => s.id !== survivor.id)
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  let next = survivor;
  for (const key of SEASON_FILLABLE_FIELDS) {
    if (next[key]) continue;
    const donor = donors.find((d) => d[key]);
    if (donor) next = { ...next, [key]: donor[key] };
  }
  if (!next.themes?.length) {
    const donor = donors.find((d) => d.themes?.length);
    if (donor) next = { ...next, themes: donor.themes };
  }
  if (!next.episodeCountTarget) {
    const donor = donors.find((d) => d.episodeCountTarget);
    if (donor) next = { ...next, episodeCountTarget: donor.episodeCountTarget };
  }
  return next;
}

/** True when two or more seasons in the list share a `number`. Pure. */
export function hasDuplicateSeasonNumbers(seasons) {
  if (!Array.isArray(seasons)) return false;
  const seen = new Set();
  for (const s of seasons) {
    if (!s) continue;
    if (seen.has(s.number)) return true;
    seen.add(s.number);
  }
  return false;
}

/**
 * Collapse seasons that share a `number` down to one record per number, and
 * report which ids were absorbed so the caller can re-point their child issues.
 * Returns `{ seasons, absorbed: Map<absorbedId, survivorId> }`.
 *
 * Two volumes numbered the same is never a state a user can act on — the Arc
 * Canvas renders both, a volume export can't tell which is canonical, and
 * arc-verify files it as a blocking finding every round. Before
 * `matchProposedSeasons` existed, auto-resolve manufactured exactly this shape,
 * so the collapse doubles as the self-heal for installs that already diverged:
 * the next arc write repairs the record without a migration (the file-migration
 * runner executes before the Postgres pool, and series are db-primary).
 *
 * Survivor preference — the record with the strongest claim to the child
 * issues, so a collapse never strands episodes:
 *   1. `locked` (the user froze it)
 *   2. most child issues
 *   3. oldest `createdAt` (the original, not the bug's mint)
 *
 * A group holding TWO OR MORE locked records is left intact: silently deleting
 * a user-frozen volume is worse than the duplicate, and only a human can say
 * which freeze was intended. Those groups keep warning every write, which is
 * the correct nag.
 */
export function collapseDuplicateSeasonNumbers(seasons, issueCountBySeasonId = new Map(), { log = true } = {}) {
  const absorbed = new Map();
  if (!Array.isArray(seasons)) return { seasons, absorbed };
  const byNumber = new Map();
  for (const s of seasons) {
    if (!s) continue;
    const group = byNumber.get(s.number);
    if (group) group.push(s);
    else byNumber.set(s.number, [s]);
  }

  const survivors = [];
  for (const [number, group] of byNumber) {
    if (group.length === 1) {
      survivors.push(group[0]);
      continue;
    }
    const lockedCount = group.filter((s) => s.locked === true).length;
    if (lockedCount > 1) {
      if (log) {
        console.warn(
          `⚠️ collapseDuplicateSeasonNumbers: volume ${number} has ${group.length} records including ${lockedCount} locked — left intact, unlock all but one to collapse`,
        );
      }
      survivors.push(...group);
      continue;
    }
    const episodes = (s) => issueCountBySeasonId.get(s.id) || 0;
    const [survivor] = [...group].sort((a, b) => (
      (b.locked === true ? 1 : 0) - (a.locked === true ? 1 : 0)
      || episodes(b) - episodes(a)
      || String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    ));
    survivors.push(backfillSeasonGaps(survivor, group));
    for (const s of group) {
      if (s.id !== survivor.id) absorbed.set(s.id, survivor.id);
    }
    if (log) {
      console.warn(
        `⚠️ collapseDuplicateSeasonNumbers: volume ${number} had ${group.length} records — kept ${survivor.id} (${episodes(survivor)} episode(s)), absorbed ${group.length - 1} into it`,
      );
    }
  }
  // Re-sort: `sanitizeSeasonList`'s number ordering is the contract consumers
  // render straight from, and the group walk above emits in first-seen order.
  return { seasons: survivors.sort((a, b) => (a.number || 0) - (b.number || 0)), absorbed };
}

/**
 * Persist a new `arc` + `seasons[]` onto a series, migrating any child issues
 * whose `seasonId` referenced a season that the new shape dropped or renamed.
 * Shared by `resolveVerifyIssues` (auto-resolve) and `/arc/generate` — both
 * paths can rewrite season ids, and without this migration the orphans land
 * behind keys the Arc Canvas never iterates back.
 *
 * Match priority (via `buildSeasonRemap`): normalized title → unique number →
 * positional 1:1 fallback. Unmatched orphans get `seasonId: null` so they fall
 * into the visible "Un-grouped" bucket instead of vanishing.
 *
 * Per-field arc locks (`series.locked.arcFields`) are honored: locked fields
 * are restored from `currentSeries.arc` before the persist, so an auto-resolve
 * that proposes a new logline can preserve the user-frozen themes verbatim.
 *
 * `currentSeries` identifies the target series. The helper refreshes the
 * latest snapshot before writing so locks toggled while an LLM run is in
 * flight are honored at commit time.
 *
 * `options.preserveDroppedSeasons` additionally re-inserts any existing season
 * the new shape omitted, whether or not it was locked — the non-destructive
 * guarantee the autopilot's `unlockForRun` mode relies on (it clears the very
 * per-season locks that would otherwise have preserved them). Content rewrites
 * to surviving seasons still apply; only deletion is refused.
 */
export async function commitSeasonsWithRemap(currentSeries, { arc, seasons }, options = {}) {
  const seriesId = currentSeries.id;
  const latestSeries = await getSeries(seriesId);
  if (latestSeries.locked?.arc === true) {
    throw new ServerError(
      'Arc is locked — unlock it before rewriting the arc',
      { status: 400, code: ERR_VALIDATION },
    );
  }
  const mergedArc = mergeArcWithLocks(latestSeries.arc, { ...arc, seriesDesign: latestSeries.arc?.seriesDesign }, latestSeries.locked?.arcFields);
  // Per-season locks: restore any locked existing seasons over LLM-proposed
  // rewrites, and re-insert any locked seasons the LLM dropped. Re-sanitize
  // so the locked records merge with the new shape (sort by number, dedup).
  const lockMerged = mergeSeasonsWithLocks(latestSeries.seasons, seasons);
  let mergedSeasons = sanitizeSeasonList(
    options.preserveDroppedSeasons === true
      ? preserveDroppedSeasonRecords(latestSeries.seasons, lockMerged)
      : lockMerged,
  );

  // One `listIssues` for the whole commit — the collapse below needs per-season
  // episode counts and the reassign sweep needs the same list.
  let allIssues = null;
  const loadIssues = async () => {
    if (allIssues === null) allIssues = await listIssues({ seriesId });
    return allIssues;
  };

  // Self-heal duplicate volume numbers on the way through. `sanitizeSeasonList`
  // dedupes by `id` only, so two records both numbered 1 survive it happily —
  // and that shape is a blocking arc-verify finding no amount of LLM rewriting
  // can clear. Absorbed ids are threaded into the remap below so their episodes
  // follow the survivor instead of falling into the ungrouped bucket.
  let absorbed = new Map();
  if (hasDuplicateSeasonNumbers(mergedSeasons)) {
    const counts = new Map();
    for (const iss of await loadIssues()) {
      if (iss.seasonId) counts.set(iss.seasonId, (counts.get(iss.seasonId) || 0) + 1);
    }
    ({ seasons: mergedSeasons, absorbed } = collapseDuplicateSeasonNumbers(mergedSeasons, counts));
  }

  const newIds = new Set(mergedSeasons.map((s) => s.id));
  const droppedOldSeasons = (latestSeries.seasons || []).filter((s) => !newIds.has(s.id));
  const oldIds = new Set((latestSeries.seasons || []).map((s) => s.id));
  const newlyMintedSeasons = mergedSeasons.filter((s) => !oldIds.has(s.id));
  const remap = buildSeasonRemap(droppedOldSeasons, newlyMintedSeasons);
  // An absorbed duplicate has a KNOWN survivor, which beats buildSeasonRemap's
  // title/number inference — that pass only considers freshly-minted seasons as
  // targets, so a duplicate absorbed into an existing record would otherwise
  // map to null and orphan every episode under it.
  for (const [absorbedId, survivorId] of absorbed) remap.set(absorbedId, survivorId);
  const droppedIdSet = new Set(droppedOldSeasons.map((s) => s.id));
  const reassignList = droppedIdSet.size
    ? (await loadIssues()).filter((iss) => droppedIdSet.has(iss.seasonId))
    : [];

  // Mirrors `deleteSeason`'s bulk-reassign idiom — `skipRenumber` per call +
  // one `recomputeIssueNumbers` after, wrapped in `withReexportSuppressed` so
  // we don't fan out N socket events + N debounced re-exports of the same
  // series.
  //
  // Persist the new seasons FIRST so that a crash between writes leaves
  // issues attached to ids that still exist in `series.seasons[]`. If we
  // wrote issues first and crashed before `updateSeries`, every reassigned
  // issue would point at a `seasonId` that's not in the persisted series —
  // the exact orphan state this helper was written to prevent.
  let updated;
  await withReexportSuppressed('series', seriesId, async () => {
    updated = await updateSeries(seriesId, { arc: mergedArc, seasons: mergedSeasons });
    for (const iss of reassignList) {
      const target = remap.get(iss.seasonId) ?? null;
      await updateIssue(iss.id, { seasonId: target }, { skipRenumber: true });
    }
    if (reassignList.length) await recomputeIssueNumbersForSeries(seriesId);
  });
  if (reassignList.length) emitRecordUpdated('series', seriesId);
  return { series: updated, reassignedIssueCount: reassignList.length };
}

// Build a Map<oldSeasonId, newSeasonId|null> from the set of removed seasons
// and the freshly-minted ones in the same resolve. Matching priority:
//   1. normalized title equality (LLM was told to preserve titles when it can)
//   2. `number` equality (only when the target number is unique among new ones)
//   3. positional fallback — only fires when exactly ONE unmatched on each
//      side. With a single pair the mapping is forced and unambiguous; with
//      2+ unmatched the LLM may have reshuffled/renamed everything and
//      positional guessing silently invents wrong mappings (the bug that
//      motivated this guard). Skipped runs log a warning and let those
//      orphans fall through to the ungrouped bucket below.
// Anything that can't be matched maps to null so the issue lands in the
// ungrouped bucket instead of staying stranded behind a defunct id.
export function buildSeasonRemap(droppedOldSeasons, newlyMintedSeasons) {
  const remap = new Map();
  const claimed = new Set();
  const norm = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : '');

  // Pass 1: normalized title
  for (const old of droppedOldSeasons) {
    const oldTitle = norm(old.title);
    if (!oldTitle) continue;
    const hit = newlyMintedSeasons.find(
      (n) => norm(n.title) === oldTitle && !claimed.has(n.id),
    );
    if (hit) {
      claimed.add(hit.id);
      remap.set(old.id, hit.id);
    }
  }

  // Pass 2: unique `number` match
  for (const old of droppedOldSeasons) {
    if (remap.has(old.id)) continue;
    if (!Number.isFinite(old.number)) continue;
    const matches = newlyMintedSeasons.filter(
      (n) => n.number === old.number && !claimed.has(n.id),
    );
    if (matches.length === 1) {
      claimed.add(matches[0].id);
      remap.set(old.id, matches[0].id);
    }
  }

  // Pass 3: positional fallback — only when the unmatched sets are exactly
  // 1↔1, where the pairing is forced.
  const oldRemaining = droppedOldSeasons.filter((s) => !remap.has(s.id));
  const newRemaining = newlyMintedSeasons.filter((n) => !claimed.has(n.id));
  if (oldRemaining.length === 1 && newRemaining.length === 1) {
    // Sanitize titles before logging — LLM-generated text can carry newlines,
    // C0/C1 control chars, or ANSI escapes that would break the project's
    // single-line logging convention or corrupt terminal output; fall back to
    // the stable id when the title is empty after sanitization.
    const safeLabel = (s) => {
      const raw = typeof s.title === 'string' ? s.title : '';
      // stripAnsi removes full ESC + CSI sequences (so "[31m" payload tails
      // don't leak through). Note: OSC sequence bodies do leak
      // through stripAnsi today — extremely unlikely in LLM-generated season
      // titles, but called out here so a future fix to ANSI_PATTERN naturally
      // tightens this path. The trailing control-char sweep catches any bare
      // C0/C1 bytes the regex doesn't match.
      const t = stripAnsi(raw)
        .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 60);
      return t || s.id;
    };
    console.warn(
      `⚠️ buildSeasonRemap Pass 3 fired: forced 1↔1 pairing "${safeLabel(oldRemaining[0])}" → "${safeLabel(newRemaining[0])}"`,
    );
    remap.set(oldRemaining[0].id, newRemaining[0].id);
    claimed.add(newRemaining[0].id);
  } else if (
    oldRemaining.length === newRemaining.length
    && oldRemaining.length > 1
  ) {
    // Suppression warn ONLY for the cases where the previous behavior would
    // have fired the positional fallback (equal counts ≥ 2). Unequal counts
    // were never positional-fallback candidates, so they don't deserve a
    // "skipped" message.
    console.warn(
      `⚠️ buildSeasonRemap skipped positional fallback (${oldRemaining.length} old × ${newRemaining.length} new unmatched) — orphan issues route to ungrouped`,
    );
  }

  // Anything still unmapped → null (ungrouped bucket).
  for (const old of droppedOldSeasons) {
    if (!remap.has(old.id)) remap.set(old.id, null);
  }
  return remap;
}
