/**
 * Owned Google OAuth2 client for Calendar and Gmail: consent URL, code exchange, refresh, and authenticated JSON requests on Node fetch.
 *
 * Replaces `google-auth-library` (#17250). The production surface is the
 * authorization-code flow plus `request()` — not service accounts, ID-token
 * verification, or proxy agents. Retry counts match the previous gaxios
 * transport so a stalled refresh still ends after the same deadlines: two
 * extra attempts when nobody answers, three retries on 408/429/5xx, and no
 * retry for POST unless the call is the token endpoint itself. A 401/403
 * refreshes once only when the stored access token has no expiry. Refresh
 * for one refresh token is single-flight, and a failed refresh leaves the
 * previous credentials in place.
 */

const EAGER_REFRESH_MS = 300_000;
const IDEMPOTENT_METHODS = ['GET', 'HEAD', 'PUT', 'OPTIONS', 'DELETE'];
const TOKEN_METHODS = [...IDEMPOTENT_METHODS, 'POST'];
const NO_RESPONSE_RETRIES = 2;
const STATUS_RETRIES = 3;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function formFields(fields) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) body.set(key, String(value));
  }
  return body;
}

// gaxios: 100ms before the first retry, then (2^n - 1) / 2 seconds.
function retryDelay(attempt) {
  const base = attempt ? 0 : 100;
  return base + ((2 ** attempt - 1) / 2) * 1000;
}

function retryableStatus(status) {
  return (status >= 100 && status <= 199) || status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function shouldRetry(error, attempt, method, enabled, methods) {
  if (!enabled || error.code === 'AbortError' || !methods.includes(method)) return false;
  if (!error.response) {
    if (attempt >= NO_RESPONSE_RETRIES) return false;
  } else if (!retryableStatus(error.response.status)) return false;
  return attempt < STATUS_RETRIES;
}

function asTransportError(error) {
  if (error instanceof Error && error.response) return error;
  // DOMException.code is a legacy number; the name (`TimeoutError`) is the contract.
  if (error instanceof Error && !(error instanceof DOMException) && (typeof error.code === 'string' || typeof error.code === 'number')) {
    return error;
  }
  const wrapped = new Error(error?.message || 'The request failed', { cause: error });
  if (error instanceof DOMException) wrapped.code = error.name;
  return wrapped;
}

function apiError(status, data) {
  let message = `Request failed with status code ${status}`;
  let code = status;
  const body = data && typeof data === 'object' ? data.error : undefined;
  if (typeof body === 'string') {
    message = body;
  } else if (body && typeof body === 'object') {
    if (typeof body.message === 'string') message = body.message;
    if (typeof body.code === 'number' || typeof body.code === 'string') code = body.code;
  }
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.response = { status, data };
  return error;
}

async function readBody(response) {
  if (response.status === 204) return '';
  const text = await response.text();
  if (!text) return '';
  const type = response.headers.get('content-type') || '';
  if (type.includes('application/json') || text.startsWith('{') || text.startsWith('[')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function normalizeTokens(data) {
  const tokens = data && typeof data === 'object' ? { ...data } : {};
  if (tokens.expires_in) {
    tokens.expiry_date = Date.now() + Number(tokens.expires_in) * 1000;
    delete tokens.expires_in;
  }
  return tokens;
}

function resolveUrl(url, params) {
  if (!params) return String(url);
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value != null) parsed.searchParams.append(key, String(value));
  }
  return parsed.toString();
}

function attemptSignal(timeout, userSignal) {
  const timeoutSignal = timeout ? AbortSignal.timeout(timeout) : null;
  if (timeoutSignal && userSignal && !userSignal.aborted) return AbortSignal.any([userSignal, timeoutSignal]);
  if (userSignal && !userSignal.aborted) return userSignal;
  return timeoutSignal;
}

export function createGoogleOAuthClient(options = {}) {
  const clientId = options.clientId || options.client_id || '';
  const clientSecret = options.clientSecret || options.client_secret || '';
  const redirectUri = options.redirectUri || options.redirect_uri;
  const endpoints = {
    oauth2AuthBaseUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    oauth2TokenUrl: 'https://oauth2.googleapis.com/token',
    ...options.endpoints,
  };
  const defaults = {
    timeout: options.timeoutMs ?? options.transporterOptions?.timeout ?? 30_000,
    fetchImplementation: options.fetchImplementation ?? options.transporterOptions?.fetchImplementation,
    signal: options.signal ?? options.transporterOptions?.signal,
    adapter: options.adapter ?? options.transporterOptions?.adapter,
  };
  const listeners = new Map();
  const flights = new Map();
  let credentials = {};

  function on(event, listener) {
    const set = listeners.get(event) ?? new Set();
    set.add(listener);
    listeners.set(event, set);
  }

  function emit(event, payload) {
    for (const listener of listeners.get(event) ?? []) listener(payload);
  }

  function isExpiring() {
    return credentials.expiry_date ? credentials.expiry_date <= Date.now() + EAGER_REFRESH_MS : false;
  }

  async function fetchOnce(prepared) {
    const fetchImpl = prepared.fetchImplementation || globalThis.fetch;
    let response;
    try {
      response = await fetchImpl(prepared.url, {
        method: prepared.method,
        headers: prepared.headers,
        body: prepared.body,
        signal: prepared.signal,
      });
    } catch (error) {
      throw asTransportError(error);
    }
    const data = await readBody(response);
    if (response.status < 200 || response.status >= 300) throw apiError(response.status, data);
    return { data, status: response.status, headers: response.headers };
  }

  async function send(opts, { token = false } = {}) {
    const method = String(opts.method || 'GET').toUpperCase();
    const retryEnabled = token || opts.retry === true;
    const methods = token ? TOKEN_METHODS : IDEMPOTENT_METHODS;
    const headers = new Headers(opts.headers ?? undefined);
    let body;
    if (opts.data !== undefined) {
      if (typeof opts.data === 'string' || opts.data instanceof URLSearchParams) {
        body = opts.data;
      } else {
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
        body = JSON.stringify(opts.data);
      }
    }
    const url = resolveUrl(opts.url, opts.params);
    let attempt = 0;
    for (;;) {
      const timeout = opts.timeout ?? defaults.timeout;
      const prepared = {
        url,
        method,
        headers,
        body,
        timeout,
        retry: opts.retry,
        signal: attemptSignal(timeout, opts.signal ?? defaults.signal),
        fetchImplementation: defaults.fetchImplementation,
      };
      try {
        return typeof defaults.adapter === 'function'
          ? await defaults.adapter(prepared, fetchOnce)
          : await fetchOnce(prepared);
      } catch (error) {
        const wrapped = asTransportError(error);
        if (!shouldRetry(wrapped, attempt, method, retryEnabled, methods)) throw wrapped;
        const wait = retryDelay(attempt);
        attempt += 1;
        await sleep(wait);
      }
    }
  }

  function refreshFlight(refreshToken) {
    if (!refreshToken) return Promise.reject(new Error('No refresh token is set.'));
    const current = flights.get(refreshToken);
    if (current) return current;
    let rejectFlight;
    let resolveFlight;
    const flight = new Promise((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });
    flights.set(refreshToken, flight);
    const body = formFields({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    });
    send({ url: String(endpoints.oauth2TokenUrl), method: 'POST', data: body }, { token: true }).then((res) => {
      const tokens = normalizeTokens(res.data);
      // A listener throw must reject the shared flight. Otherwise every waiter hangs
      // and the map entry is dropped by finally, so the next refresh cannot wake them.
      try {
        emit('tokens', tokens);
      } catch (err) {
        rejectFlight(err);
        return;
      }
      resolveFlight(tokens);
    }, rejectFlight).finally(() => { flights.delete(refreshToken); });
    return flight;
  }

  async function refreshAndStore() {
    const previousRefresh = credentials.refresh_token;
    const tokens = await refreshFlight(previousRefresh);
    if (!tokens?.access_token) throw new Error('Could not refresh access token.');
    tokens.refresh_token = previousRefresh;
    credentials = tokens;
    return tokens;
  }

  async function ensureAccessToken() {
    if (!credentials.access_token || isExpiring()) await refreshAndStore();
    return credentials.access_token;
  }

  return {
    endpoints,
    transporter: { defaults },
    get credentials() { return credentials; },
    set credentials(value) { credentials = value || {}; },
    setCredentials(value) { credentials = value || {}; },
    on,
    emit,
    generateAuthUrl(opts = {}) {
      const query = { response_type: 'code', client_id: clientId, redirect_uri: redirectUri };
      for (const [key, value] of Object.entries(opts)) {
        if (value !== undefined) query[key] = value;
      }
      if (Array.isArray(query.scope)) query.scope = query.scope.join(' ');
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value != null) params.append(key, String(value));
      }
      return `${endpoints.oauth2AuthBaseUrl}?${params.toString()}`;
    },
    async getToken(code) {
      const body = formFields({
        code: typeof code === 'string' ? code : code?.code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      const res = await send({ url: String(endpoints.oauth2TokenUrl), method: 'POST', data: body }, { token: true });
      const tokens = normalizeTokens(res.data);
      emit('tokens', tokens);
      return { tokens };
    },
    async getAccessToken() {
      const token = await ensureAccessToken();
      return { token };
    },
    async request(opts) {
      await ensureAccessToken();
      const headers = new Headers(opts.headers ?? undefined);
      opts.headers = headers;
      const attempt = () => {
        headers.set('authorization', `${credentials.token_type || 'Bearer'} ${credentials.access_token}`);
        return send(opts);
      };
      try {
        return await attempt();
      } catch (error) {
        const status = error.response?.status;
        const staleWithoutExpiry = credentials.access_token && credentials.refresh_token && !credentials.expiry_date;
        if ((status === 401 || status === 403) && staleWithoutExpiry) {
          await refreshAndStore();
          return attempt();
        }
        throw error;
      }
    },
  };
}
