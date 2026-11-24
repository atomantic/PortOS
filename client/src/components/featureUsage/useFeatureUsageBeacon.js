/**
 * Hook mounted once beside the router that reports a route to the server after 10 continuous seconds of visible, focused dwell, at most once per route per page session.
 *
 * This is the only usage signal behind feature priority tiers: a background tab driven over CDP has no focus, and a dashboard widget fetching another feature's API is not a visit. Losing focus or visibility cancels the
 * pending report and a return to the page starts the 10 seconds over; a route change does the same for the new route. A failed post is dropped (no retry, no toast), and the route is not retried. This is a one-shot event, not polling.
 */

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { postFeatureVisit } from '../../services/apiFeaturePriorities';

export const FEATURE_VISIT_DWELL_MS = 10_000;

const isAttended = () => document.visibilityState === 'visible' && document.hasFocus();

export default function useFeatureUsageBeacon(enabled = true) {
  const { pathname } = useLocation();
  // Page-session scope: lives as long as the app shell, so returning to a reported route does not post again.
  const reported = useRef(new Set());

  useEffect(() => {
    if (!enabled || reported.current.has(pathname)) return undefined;
    let timer = null;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const report = () => {
      timer = null;
      if (!isAttended()) return;
      reported.current.add(pathname);
      Promise.resolve(postFeatureVisit(pathname)).catch(() => undefined);
    };
    const sync = () => {
      if (!isAttended()) cancel();
      else if (timer === null) timer = setTimeout(report, FEATURE_VISIT_DWELL_MS);
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    return () => {
      cancel();
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
    };
  }, [pathname, enabled]);
}
