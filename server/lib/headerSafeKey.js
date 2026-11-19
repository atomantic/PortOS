/**
 * Hosted-provider API keys go in an HTTP header: `isHeaderSafeKey(v)` (printable ASCII only — no
 * whitespace, control or non-Latin-1 characters) backs the Settings save schema in `settingsValidation.js`.
 *
 * `assertHeaderSafeKey(key, label)` is the render-time guard that throws a plain 400
 * (`API_KEY_NOT_HEADER_SAFE`) naming the setting instead of fetch's opaque ByteString error, never
 * echoing the key. Pure.
 *
 * Hosted-provider API keys travel in an HTTP header (`Authorization`,
 * `x-goog-api-key`, `Reactor-API-Key`). `fetch` throws an opaque ByteString
 * error for a value with a character above U+00FF, and a space or control
 * character inside a key never authenticates. Real keys are printable ASCII
 * (Higgsfield's `KEY_ID:KEY_SECRET` included), so that is the accepted set.
 *
 * Messages name the setting and never echo the value.
 */
import { ServerError } from './errorHandler.js';

const HEADER_SAFE_KEY = /^[\x21-\x7E]+$/;

export const isHeaderSafeKey = (value) => typeof value === 'string' && HEADER_SAFE_KEY.test(value);

export const headerSafeKeyMessage = (label) =>
  `The ${label} API key contains characters that cannot be sent (whitespace, control or non-ASCII characters). Paste it again in Settings.`;

/** Render-time guard for a key already stored (or read from env): throws a plain 400 naming the setting. */
export function assertHeaderSafeKey(apiKey, label) {
  if (apiKey && !isHeaderSafeKey(apiKey)) {
    throw new ServerError(headerSafeKeyMessage(`saved ${label}`), { status: 400, code: 'API_KEY_NOT_HEADER_SAFE' });
  }
  return apiKey;
}
