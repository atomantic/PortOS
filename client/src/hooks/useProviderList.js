import * as api from '../services/api';
import useListResource from './useListResource.js';

// Module-level so the identity is stable for useListResource. `silent` because
// every consumer renders its own <ListLoadError> instead of the global toast.
const fetchProviders = () => api.getProviders({ silent: true }).then((data) => data?.providers ?? []);

/**
 * The AI provider list as a `useListResource` read: a failed `GET /providers`
 * is `state: 'error'` (render `<ListLoadError onRetry={retry}>`), never an
 * empty picker that looks like "no providers configured".
 */
export default function useProviderList({ enabled = true } = {}) {
  return useListResource(fetchProviders, { enabled });
}
