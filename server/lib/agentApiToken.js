/**
 * Provides `AGENT_API_TOKEN_ENV`, `AGENT_API_AUTH_CURL_ARG`, `agentApiCurl` and `agentApiAuthNote` for injecting
 * and using the loopback API token in agent-facing curl snippets.
 *
 * Pure (zero-import leaf deps).
 */

import { shellQuote } from './shellQuote.js';

export const AGENT_API_TOKEN_ENV = 'PORTOS_API_TOKEN';
// SHELL text (`${VAR:-}` expansion), never an HTTP header value; emitted even with auth off (empty bearer is ignored).
export const AGENT_API_AUTH_CURL_ARG = `-H "Authorization: Bearer \${${AGENT_API_TOKEN_ENV}:-}"`;
// `payload` goes through `shellQuote`: an apostrophe in an interpolated value would otherwise break the shell quoting.
export const agentApiCurl = ({ apiBase, path, payload }) => (
  `curl -sS -X POST ${apiBase}${path} -H 'Content-Type: application/json' ${AGENT_API_AUTH_CURL_ARG}${payload ? ` -d ${shellQuote(payload)}` : ''}`
);
// "may gate" is deliberate: auth is opt-in/OFF by default, so a 200 proves nothing and a 401 means a dropped header.
export const agentApiAuthNote = ({ alsoCovering = '' } = {}) => (
  `Keep that \`Authorization\` header on every PortOS API call you make${alsoCovering ? `, ${alsoCovering}` : ''}: this install may gate \`/api/*\` behind its instance password, and \`$${AGENT_API_TOKEN_ENV}\` is the session token PortOS put in your environment for exactly this. A bare \`401 AUTH_REQUIRED\` means the header was dropped, not that the endpoint is unavailable.`
);
