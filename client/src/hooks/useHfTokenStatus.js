/**
 * Read the CENTRAL HuggingFace token status (`GET /image-gen/setup/hf-token-status`,
 * backed by `server/services/hfToken.js`: stored token → env vars → `hf auth login` file).
 *
 * Every gated-model surface needs the same three-state answer — token present / not
 * present / not yet known — and each one had grown its own copy with its own failure
 * policy, so the same offline blip rendered a nag on one page and nothing on another.
 * This is the single reader.
 *
 * `present` is deliberately tri-state: `null` means "not fetched yet or the fetch
 * failed", NOT "absent". Callers must branch on all three, or a slow status call
 * flashes "add a token" at a user who already has one (the absent-vs-unknown rule in
 * AGENTS.md). A surface that would rather offer the paste form on a failed fetch opts
 * in explicitly with `errorAs: 'absent'`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { getHfTokenStatus } from '../services/api';
import useMounted from './useMounted';

const UNKNOWN = { present: null, source: null };

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled] Fetch when true; flipping to false resets the
 *   status to unknown, so a modal re-checks on each open instead of showing a stale
 *   answer from a previous session.
 * @param {'unknown'|'absent'} [options.errorAs] What a failed fetch means. Default
 *   `'unknown'` (render nothing rather than lie). `'absent'` suits a surface already
 *   opened *because* of a gated-repo failure, where offering the paste form is the
 *   more useful guess.
 * @returns {{present: boolean|null, source: string|null, refresh: () => void}}
 */
export function useHfTokenStatus({ enabled = true, errorAs = 'unknown' } = {}) {
  const [status, setStatus] = useState(UNKNOWN);
  const mountedRef = useMounted();
  // Generation counter so a response from a previous open/refresh can't overwrite a
  // newer one (the repo's stale-async convention).
  const runIdRef = useRef(0);

  const refresh = useCallback(() => {
    const runId = ++runIdRef.current;
    const apply = (next) => {
      if (mountedRef.current && runIdRef.current === runId) setStatus(next);
    };
    getHfTokenStatus()
      .then((data) => apply({ present: !!data?.hfTokenPresent, source: data?.source || 'none' }))
      .catch(() => { if (errorAs === 'absent') apply({ present: false, source: 'none' }); });
  }, [errorAs, mountedRef]);

  useEffect(() => {
    if (!enabled) {
      // Invalidate any in-flight response so it can't land after the reset.
      runIdRef.current += 1;
      setStatus(UNKNOWN);
      return;
    }
    refresh();
  }, [enabled, refresh]);

  return { ...status, refresh };
}

export default useHfTokenStatus;
