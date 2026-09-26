import { useSocketResource } from './useSocketResource.js';

const EVENTS = ['provider-quota:updated'];

/** The caller owns its entry read; reconcile later cache completions and missed events. */
export function useQuotaUpdates(reload) {
  // Do not pass the resource request object as a legacy load(refresh) argument:
  // it would force another scrape on every completion and loop indefinitely.
  useSocketResource(() => reload(), { events: EVENTS, immediate: false });
}
