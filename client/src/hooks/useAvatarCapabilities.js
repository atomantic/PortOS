import { useCallback, useEffect, useState } from 'react';
import { getRiggedAvatars } from '../services/api';

// Avatar capabilities for rigged + animated records (#5894).
//
// A retargeted character carries whatever clips its ONE retarget produced —
// usually a single clip — while every CoS state wants its own motion. This
// module is the honesty layer between the two: the server reports per-state
// coverage (`GET /avatar/rigged`, computed by
// `server/services/rigging/clipCapabilities.js`), and these resolvers turn
// that report into a playable clip WITHOUT ever pretending an uncovered state
// is covered. A missing state deterministically falls back to a clip the
// character actually has.

/** `?variant=` namespace prefix for record-backed avatar styles. */
export const RIGGED_AVATAR_PREFIX = 'rigged-';

/** Whether an avatar-style value selects a rigged record vs a built-in style. */
export const isRiggedAvatarStyle = (style) => typeof style === 'string' && style.startsWith(RIGGED_AVATAR_PREFIX);

/** The selector entry for a style value, or null when it is not offered. */
export const riggedRecordForStyle = (records, style) => (
  isRiggedAvatarStyle(style) && Array.isArray(records)
    ? records.find((record) => record?.variant === style) || null
    : null
);

/**
 * The clip a CoS state maps to under a server coverage report: the covered
 * clip when the state is covered, else the first available clip
 * (deterministic — same record, same answer), else null when the character
 * carries no clip at all. Never invents coverage.
 * @param {object|null} coverage The `coverage` half of a `/avatar/rigged` entry.
 * @param {string} state A CoS agent state.
 * @returns {string|null}
 */
export function resolveStateClip(coverage, state) {
  const stateClip = coverage?.coverageByState?.[state]?.clip;
  if (typeof stateClip === 'string' && stateClip) return stateClip;
  const available = Array.isArray(coverage?.availableClips) ? coverage.availableClips : [];
  return available.find((clip) => typeof clip === 'string' && clip) || null;
}

/**
 * The clip to actually PLAY from a loaded GLB's roster. The coverage answer
 * wins when the GLB still carries that clip (the record may have been
 * re-retargeted since the selector read it, so presence is re-checked —
 * never trusted blindly); then the caller's ordered fallbacks; then the
 * roster's first clip, so an uncovered state degrades to real motion instead
 * of a frozen frame. Null when the GLB carries nothing playable.
 * @param {string[]} names Clip names on the loaded GLB.
 * @param {{state?: string|null, coverage?: object|null, fallbacks?: string[]}} opts
 * @returns {string|null}
 */
export function resolvePlaybackClip(names, { state = null, coverage = null, fallbacks = [] } = {}) {
  const roster = Array.isArray(names) ? names.filter((name) => typeof name === 'string' && name) : [];
  const candidates = [
    ...(state && coverage ? [resolveStateClip(coverage, state)] : []),
    ...(Array.isArray(fallbacks) ? fallbacks : []),
  ];
  return candidates.find((clip) => clip && roster.includes(clip)) || roster[0] || null;
}

/**
 * One-line honest summary of a coverage report for selector copy.
 * @param {object|null} coverage
 * @returns {string}
 */
export function coverageSummary(coverage) {
  const states = coverage?.coverageByState ? Object.keys(coverage.coverageByState) : [];
  const covered = Array.isArray(coverage?.coveredStates) ? coverage.coveredStates.length : 0;
  if (states.length === 0) return 'No animation clips';
  if (covered >= states.length) return `Covers all ${states.length} CoS states`;
  if (covered > 0) return `Covers ${covered} of ${states.length} CoS states`;
  const fallback = resolveStateClip(coverage);
  return fallback ? `No covered CoS state — plays ${fallback} throughout` : 'No animation clips';
}

/**
 * The install's verified animated records for the avatar selectors. Fetches
 * once on mount; `refresh` re-reads (e.g. after a retarget completes
 * elsewhere). Failures resolve to an empty list with `error` set — the
 * selectors render their built-in styles regardless, so a rigging-lane outage
 * must never take down the CoS config screen.
 * @returns {{records: object[], loading: boolean, error: Error|null, refresh: Function}}
 */
export function useAvatarCapabilities() {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getRiggedAvatars({ silent: true });
      setRecords(Array.isArray(data?.records) ? data.records : []);
    } catch (err) {
      setRecords([]);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { records, loading, error, refresh };
}
