import toast from '../components/ui/Toast';

export const API_BASE = '/api'; // exported for sub-modules that use fetch() directly

// Stable ID for the PortOS baseline app (mirrors server PORTOS_APP_ID). Defined
// in the dependency-free lib/appIdentity.js and re-exported here so callers that
// only need the id don't drag this module's React import along with it.
export { PORTOS_APP_ID } from '../lib/appIdentity.js';

// Bounce to /login when the auth gate (server: services/authGate.js) rejects a
// request with 401 + AUTH_REQUIRED. Shared by request() AND the streaming-fetch
// helpers (apiLocalLlm.streamLocalLlmTest, etc.) that bypass request() to read a
// stream body but must still honor session expiry — otherwise a session that
// lapses mid-feature just errors in place instead of re-authenticating.
export function maybeRedirectToLogin(response, error) {
  if (response.status === 401 && error?.code === 'AUTH_REQUIRED' && typeof window !== 'undefined') {
    if (!window.location.pathname.startsWith('/login')) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/login?next=${next}`);
    }
  }
}

// Shared by raw-response callers that need to consume a stream or blob instead
// of handing the response to request(). Keep the envelope construction here so
// structured server context and status metadata survive every API surface.
export async function throwApiError(response, parsedError) {
  const error = parsedError ?? await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  maybeRedirectToLogin(response, error);
  const err = new Error(error.error || `HTTP ${response.status}`);
  err.code = error?.code;
  err.status = response.status;
  if (error?.context) err.context = error.context;
  throw err;
}

export async function request(endpoint, options = {}) {
  const { silent, responseType, ...fetchOptions } = options;
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
    await throwApiError(response).catch((error) => {
      if (!silent) {
        // Platform unavailability is a warning, not an error
        if (error.code === 'PLATFORM_UNAVAILABLE') {
          toast(error.message, { icon: '⚠️' });
        } else if (error.code !== 'AUTH_REQUIRED') {
          toast.error(error.message);
        }
      }
      throw error;
    });
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return null;
  }

  if (responseType === 'arraybuffer') {
    return response.arrayBuffer();
  }
  // `responseType: 'text'` returns the raw body so callers (e.g. catalog
  // export, which may be JSON, markdown, or YAML) get a string they can
  // wrap in a Blob and trigger a download from. JSON.parse on the caller
  // side when needed.
  if (responseType === 'text') {
    return response.text();
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
