import { useEffect, useState } from 'react';
import * as api from '../services/api';

/**
 * The reviewers a `/do:next` claim will ACTUALLY run for `appId`, or `null`
 * while the lookup is in flight or has failed.
 *
 * Distinct from `useCodeReviewDefaults`, and the distinction is the point: the
 * defaults hook reads Models → Code Reviewers, while a claim resolves its
 * reviewers from the claim-work task metadata FIRST and only falls back to those
 * defaults. An override there therefore runs a chain the defaults hook cannot
 * see — which is how a claim reviewed with `codex` while every reviewer control
 * on screen showed `antigravity`. Seed claim surfaces from here; the payload's
 * `source` says which layer won.
 *
 * `null` rather than an empty chain, because "couldn't ask" and "nothing
 * configured" must not collapse: an empty reviewer list rendered as fact would
 * read as a claim that merges with no review at all.
 *
 * Fetches once per mount; a claim drawer is mounted only while open, which is
 * the refresh.
 */
export default function useClaimReviewers(appId) {
  const [value, setValue] = useState(null);

  useEffect(() => {
    setValue(null);
    if (!appId) return undefined;
    let cancelled = false;
    api.getAppClaimReviewers(appId)
      .then((data) => {
        // The one guard that matters: without a list there is nothing to show,
        // and every other field is shaped by the route from the same resolver.
        if (!cancelled && Array.isArray(data?.reviewers)) setValue(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [appId]);

  return value;
}
