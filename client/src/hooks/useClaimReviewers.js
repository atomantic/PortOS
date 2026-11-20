/**
 * The reviewers a `/do:next` claim will ACTUALLY run for one app — claim-work task metadata resolved
 * OVER the Code Review Defaults, with `source` naming the layer that won.
 *
 * Stays `resolved: false` on a failed lookup so "couldn't ask" never reads as "nothing configured".
 * Use when: Any claim launcher (SlashDoRunDrawer, IssuesTab). `useCodeReviewDefaults` can't see a
 * claim-work override and would show reviewers the run won't use.
 */

import { useEffect, useState } from 'react';
import { getAppClaimReviewers } from '../services/apiApps.js';

/**
 * The reviewers a `/do:next` claim will ACTUALLY run for `appId`, or `null` while the lookup is in flight or has failed.
 *
 * Distinct from `useCodeReviewDefaults`: that hook reads Models → Code Reviewers, but a claim resolves from the claim-work task metadata FIRST and only then those defaults, so an override there runs a chain the defaults hook can't see (a claim reviewed with `codex` while every control showed `antigravity`).
 * Seed claim surfaces from here; the payload's `source` says which layer won. `null`, not an empty chain: "couldn't ask" and "nothing configured" must not collapse, or an empty list reads as a claim that merges with no review. Fetches once per mount (a claim drawer is mounted only while open).
 */
export default function useClaimReviewers(appId) {
  const [value, setValue] = useState(null);

  useEffect(() => {
    setValue(null);
    if (!appId) return undefined;
    let cancelled = false;
    getAppClaimReviewers(appId)
      .then((data) => {
        // The one guard that matters: without a list there is nothing to show; the route shapes every other field from the same resolver.
        if (!cancelled && Array.isArray(data?.reviewers)) setValue(data);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [appId]);

  return value;
}
