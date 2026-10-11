import { useCallback, useEffect } from 'react';
import { getCalendarEvents } from '../services/api';
import socket from '../services/socket';
import { usePagedCollection } from './usePagedCollection';

const PAGE_SIZE = 200;

// Offset counts server rows, including duplicates; collection identity includes
// the account because distinct calendars may use the same provider event id.
export function useCalendarWindowEvents(startDate, endDate) {
  const fetchPage = useCallback(async ({ cursor, signal }) => {
    const offset = cursor ?? 0;
    const data = await getCalendarEvents({ startDate, endDate, limit: PAGE_SIZE, offset }, { signal, silent: true });
    if (!Array.isArray(data?.events) || !Number.isSafeInteger(data.total) || data.total < 0
      || data.events.length > PAGE_SIZE || (data.events.length === 0 && offset < data.total)) {
      throw new Error('Calendar returned an incomplete event page');
    }
    const nextOffset = offset + data.events.length;
    return {
      items: data.events.map(event => ({ id: JSON.stringify([event.accountId, event.id]), event })),
      total: data.total,
      nextCursor: nextOffset < data.total ? nextOffset : null,
    };
  }, [startDate, endDate]);
  const { items, loaded, loading, error, hasMore, loadMore, reload } = usePagedCollection(fetchPage);

  // A grid needs its whole date window before empty cells imply availability.
  // Stop on failure; loadMore retries the same cursor without losing prior rows.
  useEffect(() => {
    if (loaded && hasMore && !loading && !error) loadMore();
  }, [loaded, hasMore, loading, error, loadMore]);

  useEffect(() => {
    const events = ['calendar:sync:completed', 'calendar:changed', 'connect'];
    for (const event of events) socket.on(event, reload);
    return () => { for (const event of events) socket.off(event, reload); };
  }, [reload]);

  return {
    events: items.map(item => item.event),
    loading: loading || (!loaded && !error),
    error,
    complete: loaded && !hasMore && !error,
    retry: loadMore,
  };
}
