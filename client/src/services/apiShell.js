import { request } from './apiCore.js';

/**
 * Hand a photo to whatever is running in a shell session — a live `claude`/`codex`
 * TUI reads the image off disk from the path the server pastes into its prompt.
 *
 * HTTP rather than the `shell:*` socket protocol: this is a one-shot request that
 * needs a result, and socket.io's 1MB frame limit can't carry a photo. Responds
 * with the STORED filename; the absolute path stays server-side.
 *
 * @param {string} sessionId
 * @param {{ data: string, filename: string, message?: string }} payload - base64
 *   image bytes, the original name, and an optional accompanying message
 * @param {{ silent?: boolean }} [options] - `silent: true` when the caller owns
 *   its own error UI (see the toasting convention in apiCore.js)
 * @returns {Promise<{ sessionId: string, filename: string }>}
 */
export const sendShellImage = (sessionId, { data, filename, message }, options = {}) =>
  request(`/shell/sessions/${encodeURIComponent(sessionId)}/image`, {
    method: 'POST',
    body: JSON.stringify({ data, filename, message }),
    ...options,
  });

/**
 * Capability state of the Shell page's iTerm2 view (#8114): `{ state, detail }`,
 * never session contents. States and their fixes are in docs/ITERM.md.
 * @param {{ silent?: boolean }} [options]
 */
export const getItermStatus = (options = {}) => request('/iterm/status', options);
