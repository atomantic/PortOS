/**
 * Where the local agent API key lives on disk, shared by the server that writes
 * it (`server/services/agentKey.js`) and the CLI that spends it
 * (`scripts/portos-api.js`).
 *
 * The key is for agents PortOS did NOT spawn — a Claude Code / Codex session the
 * operator runs in a terminal on the same machine. PortOS-spawned agents already
 * get `PORTOS_API_TOKEN` injected (`server/services/agentApiAuth.js`); an outside
 * session has no environment to inherit, so the server keeps a session token in a
 * file only the host user can read, and the session reads it from there.
 *
 * Outside `data/` on purpose: `data/` is backed up and mirrored, and
 * `auth-sessions.json` stores only token hashes so a copy of it is never a
 * credential. This file holds the plaintext token, so it stays in the user's
 * home directory with mode 0600 and never travels.
 *
 * Builtins only — the CLI must load from a bare checkout.
 */

import { homedir } from 'os';
import { join } from 'path';

export const AGENT_KEY_FILE_ENV = 'PORTOS_AGENT_KEY_FILE';

/** The key file path: `$PORTOS_AGENT_KEY_FILE`, else `~/.portos/agent-key.json`. */
export const resolveAgentKeyFile = (env = process.env) => (
  env[AGENT_KEY_FILE_ENV] || join(homedir(), '.portos', 'agent-key.json')
);

/** The same path for display, with the home directory shown as `~`. */
export const displayAgentKeyFile = (path) => {
  const home = homedir();
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};
