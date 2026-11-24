/**
 * Hook mounted once beside the router that reports a route to the server after 10 continuous seconds of visible, focused dwell, at most once per route per local calendar day of a page session.
 *
 * This is the only usage signal behind feature priority tiers: a background tab driven over CDP has no focus, and a dashboard widget fetching another feature's API is not a visit. Losing focus or visibility cancels the
 * pending report and a return to the page starts the 10 seconds over; a route change does the same for the new route. The per-day scope keeps a tab left open for days contributing a visit each day it is used, since the server learns from distinct active days. A failed post is dropped (no retry, no toast), and the route is not retried that day. This is a one-shot event, not polling.
 */

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { postFeatureVisit } from '../../services/apiFeaturePriorities';

export const FEATURE_VISIT_DWELL_MS = 10_000;

const isAttended = () => document.visibilityState === 'visible' && document.hasFocus();

// en-CA formats as YYYY-MM-DD in the browser's local zone, the same calendar day the server buckets visits into.
const localDay = () => new Date().toLocaleDateString('en-CA');

export default function useFeatureUsageBeacon(enabled = true) {
  const { pathname } = useLocation();
  // Keyed by local day and route: lives as long as the app shell, so returning to a reported route the same day does not post again.
  const reported = useRef(new Set());

  useEffect(() => {
    const reportKey = () => `${localDay()}|${pathname}`;
    if (!enabled) return undefined;
    let timer = null;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const report = () => {
      timer = null;
      if (!isAttended()) return;
      reported.current.add(reportKey());
      Promise.resolve(postFeatureVisit(pathname)).catch(() => undefined);
    };
    const sync = () => {
      if (!isAttended() || reported.current.has(reportKey())) cancel();
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
