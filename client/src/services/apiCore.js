import toast from '../components/ui/Toast';

export const API_BASE = '/api'; // exported for sub-modules that use fetch() directly

// Stable ID for the PortOS baseline app (mirrors server PORTOS_APP_ID)
export const PORTOS_APP_ID = 'portos-default';

export async function request(endpoint, options = {}) {
  const { silent, ...fetchOptions } = options;
  const url = `${API_BASE}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...fetchOptions.headers
    },
    ...fetchOptions
  };

  const response = await fetch(url, config).catch(() => null);
  if (!response) {
    const msg = 'Server unreachable — check your connection and try again';
    if (!silent) toast.error(msg);
    throw new Error(msg);
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    const errorMessage = error.error || `HTTP ${response.status}`;
    if (!silent) {
      // Platform unavailability is a warning, not an error
      if (error.code === 'PLATFORM_UNAVAILABLE') {
        toast(errorMessage, { icon: '⚠️' });
      } else {
        toast.error(errorMessage);
      }
    }
    throw new Error(errorMessage);
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return null;
  }

  return response.json();
}

// Search
export const search = (q) => request(`/search?q=${encodeURIComponent(q)}`);

// Default export for simplified imports
export default {
  get: (endpoint, options) => request(endpoint, { method: 'GET', ...options }),
  post: (endpoint, body, options) => request(endpoint, {
    method: 'POST',
    body: JSON.stringify(body),
    ...options
  }),
  put: (endpoint, body, options) => request(endpoint, {
    method: 'PUT',
    body: JSON.stringify(body),
    ...options
  }),
  delete: (endpoint, options) => request(endpoint, { method: 'DELETE', ...options })
};
