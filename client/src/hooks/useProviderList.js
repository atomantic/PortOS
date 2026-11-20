/**
 * `useProviderList({ enabled })` → the `useListResource` shape (`{ items, state, error, retry,
 * setItems }`) over `GET /providers`, silent so the caller owns the error UI.
 *
 * Use when: Any picker or tab that needs the provider list — render `<ListLoadError what="AI
 * providers" onRetry={retry}>` on `error`, and gate "no providers" copy on `state === 'ready'`.
 */

import { getProviders } from '../services/apiProviders.js';
import useListResource from './useListResource.js';

// Module-level so the identity is stable for useListResource. `silent` because
// every consumer renders its own <ListLoadError> instead of the global toast.
const fetchProviders = () => getProviders({ silent: true }).then((data) => data?.providers ?? []);

/**
 * The AI provider list as a `useListResource` read: a failed `GET /providers`
 * is `state: 'error'` (render `<ListLoadError onRetry={retry}>`), never an
 * empty picker that looks like "no providers configured".
 */
export default function useProviderList({ enabled = true } = {}) {
  return useListResource(fetchProviders, { enabled });
}
