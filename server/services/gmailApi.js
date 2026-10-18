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
  const call = (method, path, { query, body, options } = {}) => {
    const search = query?.toString();
    return auth.request({
      url: `${GMAIL_ORIGIN}${path}${search ? `?${search}` : ''}`,
      method,
      timeout: GOOGLE_API_TIMEOUT_MS,
      ...(body !== undefined && { data: body }),
      ...options
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

    // `options` overrides per-request transport settings (e.g. a shorter
    // `timeout`, `retry: false`) without widening the endpoint surface.
    getMessage: (id, { format, metadataHeaders = [] } = {}, options) => {
      const query = new URLSearchParams();
      if (format) query.set('format', format);
      for (const header of metadataHeaders) query.append('metadataHeaders', header);
      return call('GET', messagePath(id), { query, options });
    },

    // No idempotency key exists for send: the caller passes `retry: false` so
    // the transport never resubmits after a lost acknowledgement.
    sendMessage: (body, options) => call('POST', '/messages/send', { body, options }),

    trashMessage: (id) => call('POST', `${messagePath(id)}/trash`),

    modifyMessage: (id, body) => call('POST', `${messagePath(id)}/modify`, { body })
  };
}
