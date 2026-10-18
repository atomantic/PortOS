import { GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';

// Fixed origin: the adapter never accepts a caller-supplied URL, so the OAuth
// bearer token can only be sent to the Gmail v1 "me" mailbox.
const GMAIL_ORIGIN = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Small authenticated adapter over the six Gmail v1 operations PortOS uses.
 * Transport, token refresh and the 30s deadline come from the shared OAuth
 * client's `request()`; this module only owns paths, queries and JSON bodies.
 * Every method resolves to the parsed response body and rejects with the
 * client's error (`err.response?.status` carries the HTTP status).
 *
 * @param {{ request: Function }} auth - authenticated OAuth2 client
 */
export function createGmailApi(auth) {
  const call = (method, path, { query, body, options, neverRetry = false } = {}) => {
    const search = query?.toString();
    const requestedTimeout = options?.timeout;
    const timeout = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, GOOGLE_API_TIMEOUT_MS)
      : GOOGLE_API_TIMEOUT_MS;
    return auth.request({
      url: `${GMAIL_ORIGIN}${path}${search ? `?${search}` : ''}`,
      method,
      timeout,
      ...(body !== undefined && { data: body }),
      ...((neverRetry || options?.retry === false) && { retry: false })
    }).then((res) => res.data);
  };
  const messagePath = (id) => `/messages/${encodeURIComponent(id)}`;

  return {
    listSendAs: () => call('GET', '/settings/sendAs'),

    listMessages: ({ q, maxResults, pageToken }) => {
      const query = new URLSearchParams();
      if (q !== undefined) query.set('q', q);
      if (maxResults !== undefined) query.set('maxResults', String(maxResults));
      if (pageToken) query.set('pageToken', pageToken);
      return call('GET', '/messages', { query });
    },

    // Only a shorter timeout and explicitly disabled retries are accepted as
    // transport options. The fixed endpoint, verb, data and timeout ceiling
    // are always owned by this adapter.
    getMessage: (id, { format, metadataHeaders = [] } = {}, options) => {
      const query = new URLSearchParams();
      if (format) query.set('format', format);
      for (const header of metadataHeaders) query.append('metadataHeaders', header);
      return call('GET', messagePath(id), { query, options });
    },

    // No idempotency key exists for send, so the transport never resubmits it
    // after a lost acknowledgement, regardless of caller-supplied options.
    sendMessage: (body, options) => call('POST', '/messages/send', { body, options, neverRetry: true }),

    trashMessage: (id) => call('POST', `${messagePath(id)}/trash`),

    modifyMessage: (id, body) => call('POST', `${messagePath(id)}/modify`, { body })
  };
}
