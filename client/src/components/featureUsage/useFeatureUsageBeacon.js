/**
 * Hook mounted once beside the router that reports a route to the server after 10 continuous seconds of visible, focused dwell, then at most once per route every 6 hours.
 *
 * This is the only usage signal behind feature priority tiers: a background tab driven over CDP has no focus, and a dashboard widget fetching another feature's API is not a visit. Losing focus or visibility cancels the
 * pending report and a return to the page starts the 10 seconds over; a route change does the same for the new route. The server learns from distinct active days, so a tab left open across midnight must keep contributing:
 * a route is reported again once 6 hours have passed, by a single re-check timer armed while the page stays attended (no calendar math, so the browser's and the server's time zones never need to agree; the server counts
 * extra posts harmlessly, since only distinct days score). A failed post is dropped (no retry, no toast). This is a one-shot event per interval, not polling.
 */

import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { postFeatureVisit } from '../../services/apiFeaturePriorities';

export const FEATURE_VISIT_DWELL_MS = 10_000;
export const FEATURE_VISIT_REPORT_INTERVAL_MS = 6 * 60 * 60 * 1000;

const isAttended = () => document.visibilityState === 'visible' && document.hasFocus();

export default function useFeatureUsageBeacon(enabled = true) {
  const { pathname } = useLocation();
  // Route -> time of its last report, for the life of the app shell.
  const lastReportedAt = useRef(new Map());

  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    const cancel = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    // Declared before use by `report`, which re-arms through `sync` once its interval elapses.
    let sync;
    const report = () => {
      timer = null;
      if (!isAttended()) return;
      lastReportedAt.current.set(pathname, Date.now());
      Promise.resolve(postFeatureVisit(pathname)).catch(() => undefined);
      timer = setTimeout(() => { timer = null; sync(); }, FEATURE_VISIT_REPORT_INTERVAL_MS);
    };
    sync = () => {
      if (!isAttended()) {
        cancel();
        return;
      }
      if (timer !== null) return;
      const reportedAt = lastReportedAt.current.get(pathname);
      const remaining = reportedAt === undefined ? 0 : reportedAt + FEATURE_VISIT_REPORT_INTERVAL_MS - Date.now();
      timer = remaining > 0
        ? setTimeout(() => { timer = null; sync(); }, remaining)
        : setTimeout(report, FEATURE_VISIT_DWELL_MS);
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
