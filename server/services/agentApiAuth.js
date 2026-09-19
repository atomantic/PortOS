/**
 * The loopback API credential a CoS agent runs with.
 *
 * PortOS's optional instance password gates every `/api/*` path (`authGate.js`),
 * and it is the recommended posture — it is what keeps a tailnet/LAN neighbour
 * off this install. Agents, though, get no browser cookie, and
 * `auth-sessions.json` stores only token HASHES, so nothing in the environment
 * can be turned back into a credential. The result was that every canned `curl`
 * PortOS hands its own agents — the local-LLM reviewer endpoint, the review
 * challenge protocol, the MCP agent-context endpoint — answered
 * `401 AUTH_REQUIRED` on a password-protected install, which reads to the agent
 * as "the reviewer is broken" rather than "you were never given a credential".
 *
 * So mint one session token for agent use and hand it over as
 * `PORTOS_API_TOKEN`. This widens no boundary: an agent already runs shell on
 * the machine that owns the session store and could call `createSession()`
 * itself. The instance PASSWORD is never exposed — only a session token, which
 * the user can revoke wholesale by rotating the password or logging out
 * everywhere. One token is shared by every agent rather than minted per spawn,
 * so the session store does not grow a record per run.
 */
import { authEvents, createSession, isAuthEnabled, verifySession } from './auth.js';
import { isPublicReviewRestrictedProfile } from '../lib/agentExecutionProfiles.js';
import { createSingleFlight } from '../lib/singleFlight.js';
// The variable name is shared with the prompt builders that write the agent's
// `curl` snippets — see lib/agentApiToken.js.
import { AGENT_API_TOKEN_ENV } from '../lib/agentApiToken.js';

// Re-mint with a day of life left rather than handing a long agent run a token
// that expires mid-flight. Sessions live 30 days, so this refreshes ~monthly.
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

let cached = null;
// One in-flight mint shared by a burst of concurrent spawns — otherwise a
// parallel dispatch writes a session record per agent.
let minting = createSingleFlight();

// A password rotation (and an explicit log-out-everywhere) drops every session,
// including this one. Forget it immediately so the next spawn mints a live token
// instead of handing out one the gate will reject.
authEvents.on('sessions:revoked-all', () => { cached = null; });

/**
 * Still valid AND not about to expire. `verifySession` is a Map lookup against
 * the already-loaded session store, so re-checking on every spawn is cheap — and
 * it is what catches a session store that was cleared out from under us (a
 * restored backup, a hand-edited `auth-sessions.json`).
 */
const isUsable = async (entry) => !!entry
  && entry.expiresAt - Date.now() > REFRESH_MARGIN_MS
  && await verifySession(entry.token);

/**
 * The env overlay a spawning agent gets, layered in beside the other credential
 * overlays (`resolveForgeTokenEnv`'s `GH_TOKEN`, the Claude settings env).
 *
 * A public-review stage gets NOTHING: its input is contributor-controlled text,
 * so it must never hold a credential to this install's API. `buildCliChildEnv`'s
 * allowlist would strip the variable anyway; returning early means the token is
 * never minted for that stage to begin with.
 *
 * @param {object} [options]
 * @param {string|null} [options.safetyProfile] - the spawn's execution profile
 * @returns {Promise<object>} `{ PORTOS_API_TOKEN }`, or `{}` when this install
 *   has no instance password (the disabled gate ignores the empty bearer the
 *   agent's curls then send), the stage is public-content, or the mint failed
 */
export async function resolveAgentApiEnv({ safetyProfile = null } = {}) {
  if (isPublicReviewRestrictedProfile(safetyProfile)) return {};
  if (!await isAuthEnabled()) return {};
  if (await isUsable(cached)) return { [AGENT_API_TOKEN_ENV]: cached.token };
  const minted = await minting.run(AGENT_API_TOKEN_ENV, () => createSession()
    .then(({ token, expiresAt }) => {
      cached = { token, expiresAt };
      return cached;
    })
    // A failed mint must not take the spawn down with it: the agent still runs,
    // its API calls just answer 401 as they did before the token existed.
    .catch((err) => {
      console.error(`❌ Failed to mint the agent API token: ${err.message}`);
      return null;
    }));
  return minted ? { [AGENT_API_TOKEN_ENV]: minted.token } : {};
}

export const __testing = {
  reset: () => { cached = null; minting = createSingleFlight(); },
};
