/**
 * The loopback API credential a CoS agent runs with.
 *
 * With the optional instance password on, agents get no browser cookie and `auth-sessions.json`
 * stores only token HASHES, so every canned `curl` PortOS hands its agents would 401. So mint one
 * session token and hand it over as `PORTOS_API_TOKEN`. This widens no boundary (an agent already
 * runs shell on the machine and could call `createSession()`); the PASSWORD is never exposed and
 * the token is revoked by rotating the password. One token is shared by all agents so the session
 * store doesn't grow a record per run.
 */
import { authEvents, createSession, isAuthEnabled, verifySession } from './auth.js';
import { isPublicReviewRestrictedProfile } from '../lib/agentExecutionProfiles.js';
import { createSingleFlight } from '../lib/singleFlight.js';
// Shared with the prompt builders that write the agent's `curl` snippets (lib/agentApiToken.js).
import { AGENT_API_TOKEN_ENV } from '../lib/agentApiToken.js';

// Re-mint with a day left so a long run's token can't expire mid-flight (sessions live 30 days).
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

let cached = null;
// One in-flight mint shared by concurrent spawns, so a parallel dispatch writes one session record.
let minting = createSingleFlight();

// A password rotation / log-out-everywhere drops every session, including this one.
authEvents.on('sessions:revoked-all', () => { cached = null; });

/** Still valid and not about to expire; `verifySession` is a cheap Map lookup and catches a cleared session store (restored backup, hand edit). */
const isUsable = async (entry) => !!entry
  && entry.expiresAt - Date.now() > REFRESH_MARGIN_MS
  && await verifySession(entry.token);

/**
 * The env overlay a spawning agent gets, beside the other credential overlays. A public-review
 * stage gets NOTHING: its input is contributor-controlled text, so the token is never even minted.
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
  const minted = await minting.run(AGENT_API_TOKEN_ENV, () => createSession({ label: 'agent' })
    .then(({ token, expiresAt }) => {
      cached = { token, expiresAt };
      return cached;
    })
    // A failed mint must not take the spawn down: the agent still runs and its API calls answer 401.
    .catch((err) => {
      console.error(`❌ Failed to mint the agent API token: ${err.message}`);
      return null;
    }));
  return minted ? { [AGENT_API_TOKEN_ENV]: minted.token } : {};
}

export const __testing = {
  reset: () => { cached = null; minting = createSingleFlight(); },
};
