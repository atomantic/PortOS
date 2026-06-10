import { useState, useEffect } from 'react';
import * as api from '../services/api';
import socket from '../services/socket';

// Sidebar apps list: load on mount and refresh whenever the server emits
// `apps:changed`. Archived apps are filtered out and the rest sorted by name.
// Unlike the series/universes lists this is socket-driven (not focus-debounced)
// because app create/rename/archive events are pushed live.
export function useSidebarApps() {
  const [apps, setApps] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const fetchApps = () => {
      api.getApps({ silent: true })
        .then((result) => {
          if (cancelled) return;
          setApps((result || [])
            .filter((a) => !a.archived)
            .sort((a, b) => (a.name || '').localeCompare(b.name || '')));
        })
        .catch((err) => {
          console.warn(`⚠️ Layout: getApps refresh failed: ${err?.message || err}`);
        });
    };
    fetchApps();
    socket.on('apps:changed', fetchApps);
    return () => {
      cancelled = true;
      socket.off('apps:changed', fetchApps);
    };
  }, []);
  return apps;
}
