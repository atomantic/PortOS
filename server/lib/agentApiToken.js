/**
 * The name of the loopback API credential PortOS hands its own agents, and the
 * `curl` argument that spends it — one source of truth for the two halves,
 * which live far apart: the spawn sites that inject the variable
 * (`services/agentApiAuth.js` and the three env-composition sites) and the
 * prompt builders that write the `curl` snippets an agent copy-pastes.
 *
 * Pure so a prompt section can name the credential without pulling the
 * auth/settings subtree into its import closure; `shellQuote.js` is itself a
 * zero-import leaf, so the one edge costs nothing.
 */

import { shellQuote } from './shellQuote.js';

export const AGENT_API_TOKEN_ENV = 'PORTOS_API_TOKEN';

/**
 * Attached to every agent-facing `curl` against this install's own API. It is
 * SHELL text, not a value: `${VAR:-}` is parameter expansion, so it is only
 * meaningful inside a command a shell runs — never pass it to an HTTP client
 * as a header string.
 *
 * Emitted unconditionally: a prompt is built without asking whether the
 * instance password is set, an install with auth OFF ignores the empty bearer
 * the `:-` default produces, and an install with auth ON needs the header on
 * every call or the request is a bare `401 AUTH_REQUIRED`. The whole value is
 * one quoted argument, so a token is never word-split.
 */
export const AGENT_API_AUTH_CURL_ARG = `-H "Authorization: Bearer \${${AGENT_API_TOKEN_ENV}:-}"`;

/**
 * One agent-facing `curl` against this install's own API, with the credential
 * already spent on it.
 *
 * Every prompt that hands an agent an API call needs the same five pieces in
 * the same order, and a call assembled by hand is one `-H` away from a bare
 * `401` the agent reads as a broken endpoint.
 *
 * `payload` is JSON the caller built, and it goes through `shellQuote` rather
 * than into hand-written `'…'`: the agent pastes this line into a shell, so a
 * single apostrophe anywhere in it — one interpolated task id or fingerprint is
 * enough — would close the quoting and turn the rest of the JSON into shell
 * words. Today's payloads happen not to contain one, which is exactly why the
 * bug would ship silently.
 */
export const agentApiCurl = ({ apiBase, path, payload }) => (
  `curl -sS -X POST ${apiBase}${path} -H 'Content-Type: application/json' ${AGENT_API_AUTH_CURL_ARG}${payload ? ` -d ${shellQuote(payload)}` : ''}`
);

/**
 * The sentence that has to travel with every one of those calls.
 *
 * "MAY gate" is the accurate reading and the one that matters: auth is opt-in
 * and OFF by default (root `AGENTS.md`, Security Model), the `:-` default keeps
 * the command valid either way, and an agent told the install definitely gates
 * `/api/*` draws the wrong conclusion from a 200. What it must not conclude is
 * the reverse — that a `401` means the endpoint is gone.
 *
 * `alsoCovering` names the other calls in the same prompt the header applies
 * to, so a multi-call protocol does not have to restate the whole paragraph.
 */
export const agentApiAuthNote = ({ alsoCovering = '' } = {}) => (
  `Keep that \`Authorization\` header on every PortOS API call you make${alsoCovering ? `, ${alsoCovering}` : ''}: this install may gate \`/api/*\` behind its instance password, and \`$${AGENT_API_TOKEN_ENV}\` is the session token PortOS put in your environment for exactly this. A bare \`401 AUTH_REQUIRED\` means the header was dropped, not that the endpoint is unavailable.`
);
