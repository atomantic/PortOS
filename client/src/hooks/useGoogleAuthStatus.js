import { useCallback, useEffect, useRef, useState } from 'react';
import { getGoogleAuthStatus } from '../services/api';

/**
 * Google OAuth status shared by the Calendar and Messages config tabs.
 *
 * `state` is `'loading' | 'ready' | 'error'`. A failed read must not render as
 * "setup required": that branch offers the credential form and automated setup,
 * and saving there overwrites a working OAuth client. Render the setup flow only
 * on `'ready'`. `reload()` re-reads after an auth mutation and keeps the last
 * good status on screen while it runs; a response from a superseded read is
 * dropped. `retry()` is the error-state Retry and shows loading meanwhile.
 */
export function useGoogleAuthStatus({ enabled = true } = {}) {
  const [resource, setResource] = useState({ status: null, state: 'loading', error: null });
  const generation = useRef(0);

  const reload = useCallback(() => {
    generation.current += 1;
    const current = generation.current;
    return getGoogleAuthStatus({ silent: true }).then(
      (status) => {
        if (generation.current === current) setResource({ status, state: 'ready', error: null });
      },
      (error) => {
        if (generation.current === current) setResource({ status: null, state: 'error', error });
      },
    );
  }, []);

  const retry = useCallback(() => {
    setResource({ status: null, state: 'loading', error: null });
    return reload();
  }, [reload]);

  useEffect(() => {
    if (enabled) reload();
    return () => { generation.current += 1; };
  }, [enabled, reload]);

  return { ...resource, reload, retry };
}
