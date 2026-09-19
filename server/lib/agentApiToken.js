/**
 * The name of the loopback API credential PortOS hands its own agents, and the
 * `curl` argument that spends it — one source of truth for the two halves,
 * which live far apart: the spawn sites that inject the variable
 * (`services/agentApiAuth.js` and the three env-composition sites) and the
 * prompt builders that write the `curl` snippets an agent copy-pastes.
 *
 * Pure and dependency-free so a prompt section can name the credential without
 * pulling the auth/settings subtree into its import closure.
 */

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
