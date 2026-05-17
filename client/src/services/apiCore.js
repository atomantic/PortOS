import toast from '../components/ui/Toast';

export const API_BASE = '/api'; // exported for sub-modules that use fetch() directly

// Stable ID for the PortOS baseline app (mirrors server PORTOS_APP_ID)
export const PORTOS_APP_ID = 'portos-default';

export async function request(endpoint, options = {}) {
  const { silent, ...fetchOptions } = options;
  const url = `${API_BASE}${endpoint}`;
  // Skip the JSON content-type header for FormData bodies — the browser must
  // set `multipart/form-data; boundary=…` itself, and any pre-supplied value
  // (including ours) suppresses the auto-boundary and breaks the upload.
  const isFormData = typeof FormData !== 'undefined' && fetchOptions.body instanceof FormData;
  const baseHeaders = isFormData ? {} : { 'Content-Type': 'application/json' };
  const config = {
    ...fetchOptions,
    headers: {
      ...baseHeaders,
      ...fetchOptions.headers
    }
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
    const err = new Error(errorMessage);
    err.code = error?.code;
    err.status = response.status;
    // Forward structured context the server attached to the error (e.g.
    // ERR_PARTIAL_COMMIT_ISSUES carries `{ universeId, seriesId,
    // arcAlreadyPersisted, skipArcOnRetry }` so the Importer client can
    // shape its retry without re-overwriting persisted state).
    if (error?.context) err.context = error.context;
    throw err;
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
