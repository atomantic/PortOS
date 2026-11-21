/**
 * Apps list for sidebar nav: socket-driven (`apps:changed`), archived filtered out, name-sorted.
 *
 * Use when: The sidebar apps section.
 */

import { useMemo } from 'react';
import { getApps } from '../services/apiApps.js';
import { useSocketResource } from './useSocketResource';

const APPS_EVENTS = ['apps:changed'];
const NO_APPS = [];

// Archived apps are filtered out and the rest sorted by name. The default is
// the cheap navigation projection; a detail-oriented consumer can opt into the
// frozen full list with includeDetails. Reconnect, tab-show and burst
// reconciliation come from useSocketResource.
export function useSidebarApps({ includeDetails = false, enabled = true } = {}) {
  const { data } = useSocketResource(
    async () => {
      const result = await getApps({ silent: true, ...(includeDetails ? {} : { view: 'nav' }) });
      return (result || [])
        .filter((a) => !a.archived)
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    },
    { enabled, events: APPS_EVENTS, resourceKey: includeDetails },
  );
  return useMemo(() => data ?? NO_APPS, [data]);
}
