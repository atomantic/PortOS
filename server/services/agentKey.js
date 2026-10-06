/**
 * The local agent API key: a revocable session token PortOS keeps in a file
 * only the host user can read, so an agent PortOS did NOT spawn — a Claude Code
 * or Codex session the operator runs on this machine — can call the API without
 * the instance password.
 *
 * PortOS-spawned agents get `PORTOS_API_TOKEN` injected at spawn
 * (`agentApiAuth.js`). An outside session has no spawn to inherit from, and the
 * only other way to a session token is signing in with the password. This is
 * the same trust step `agentApiAuth.js` already takes: anything that can read a
 * mode-0600 file in the user's home directory runs as that user and could read
 * `auth-sessions.json` and mint a session itself. The key is never granted by
 * network position — loopback is not proof of locality (Tailscale serve and the
 * dev proxy both arrive on 127.0.0.1) — only by holding the token.
 *
 * Off by default; the operator turns it on in Settings > Security. While on,
 * the server keeps exactly one live `agent-key` session and the file current:
 * it re-mints a week before the 30-day session expires, and again after a
 * password rotation or log-out-everywhere drops every session. Turning it off
 * revokes the session and deletes the file. The flag lives under
 * `secrets.agentKey` so the generic settings GET/PUT never sees or sets it.
 */
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import {
  authEvents,
  createSession,
  describeSession,
  isAuthEnabled,
  revokeSessionsByLabel,
} from './auth.js';
import { getSettings, settingsEvents, updateSettingsWith } from './settings.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { displayAgentKeyFile, resolveAgentKeyFile } from '../../lib/agentKeyFile.js';

export const AGENT_KEY_LABEL = 'agent-key';

// Re-mint with a week of life left, so a machine that sleeps for a few days
// never wakes to an expired key. Sessions live 30 days (SESSION_TTL_MS).
const REFRESH_MARGIN_MS = 7 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'portos-api.js');

let apiUrl = null;
let timer = null;
let listening = false;

const defaultApiUrl = () => `http://127.0.0.1:${Number(process.env.PORT) || PORTS.API}`;

const isKeyEnabled = async () => (await getSettings())?.secrets?.agentKey?.enabled === true;

const readKeyFile = async (path) => {
  const raw = await readFile(path, 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

// Write-then-rename so a reader never sees a half-written key, with the
// directory at 0700 and the file at 0600 before it ever holds the token.
const writeKeyFile = async (path, body) => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
};

const keyFileBody = ({ token, expiresAt, sessionId }) => ({
  version: 1,
  url: apiUrl || defaultApiUrl(),
  token,
  sessionId,
  expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
  cli: CLI_PATH,
  usage: token
    ? 'Send "Authorization: Bearer <token>" to url. Revoke in PortOS Settings > Security.'
    : 'This install has no password set, so no token is needed.',
});

/** Whether the file's token is a live agent-key session with time to spare. */
const currentKey = async (file) => {
  if (typeof file?.token !== 'string' || file.url !== (apiUrl || defaultApiUrl())) return null;
  const session = await describeSession(file.token);
  if (session?.label !== AGENT_KEY_LABEL) return null;
  return session.expiresAt - Date.now() > REFRESH_MARGIN_MS ? session : null;
};

/**
 * Bring the file and the session store in line with the setting. Idempotent:
 * a key that is still current is left alone. `force` mints a new key even
 * when the current one is fine (Rotate).
 */
const reconcileOnce = async ({ force = false } = {}) => {
  const path = resolveAgentKeyFile();
  if (!await isKeyEnabled()) {
    await rm(path, { force: true });
    await revokeSessionsByLabel(AGENT_KEY_LABEL);
    return;
  }
  if (!await isAuthEnabled()) {
    // No password: the gate ignores credentials, so the file only tells a
    // session where the API is. Sessions were cleared when the password was.
    const file = await readKeyFile(path);
    if (file?.token !== null || file?.url !== (apiUrl || defaultApiUrl())) {
      await writeKeyFile(path, keyFileBody({ token: null }));
    }
    return;
  }
  if (!force && await currentKey(await readKeyFile(path))) return;
  const { token, expiresAt, id } = await createSession({ label: AGENT_KEY_LABEL });
  await writeKeyFile(path, keyFileBody({ token, expiresAt, sessionId: id }));
  // Only after the new key is on disk: exactly one live agent-key session.
  await revokeSessionsByLabel(AGENT_KEY_LABEL, { keepId: id });
  console.log(`🔑 Agent API key written to ${displayAgentKeyFile(path)}`);
};

// One reconcile at a time; triggers that land mid-run collapse into one rerun.
let running = null;
let rerun = false;
let rerunForce = false;
const reconcile = ({ force = false } = {}) => {
  if (running) {
    rerun = true;
    rerunForce ||= force;
    return running;
  }
  running = (async () => {
    let nextForce = force;
    do {
      rerun = false;
      await reconcileOnce({ force: nextForce });
      nextForce = rerunForce;
      rerunForce = false;
    } while (rerun);
  })().finally(() => { running = null; });
  return running;
};

const reconcileInBackground = (reason) => {
  reconcile().catch((err) => console.error(`❌ Agent API key refresh failed (${reason}): ${err.message}`));
};

/**
 * Boot hook. `localApiUrl` is the loopback origin this process serves the API
 * on (the HTTP mirror when HTTPS is on), written into the file for the CLI.
 */
export const initAgentKey = ({ localApiUrl } = {}) => {
  apiUrl = localApiUrl || defaultApiUrl();
  if (!listening) {
    listening = true;
    // Covers the flag itself, and a password being set or cleared.
    settingsEvents.on('settings:updated', () => reconcileInBackground('settings changed'));
    // A rotation or log-out-everywhere dropped the key's session with the rest.
    authEvents.on('sessions:revoked-all', () => reconcileInBackground('sessions revoked'));
  }
  if (!timer) {
    timer = setInterval(() => reconcileInBackground('daily check'), CHECK_INTERVAL_MS);
    timer.unref?.();
  }
  reconcileInBackground('boot');
};

/** What Settings > Security shows. Never includes the token. */
export const getAgentKeyStatus = async () => {
  const path = resolveAgentKeyFile();
  const [enabled, authEnabled, file] = await Promise.all([isKeyEnabled(), isAuthEnabled(), readKeyFile(path)]);
  const session = enabled && authEnabled && typeof file?.token === 'string' ? await describeSession(file.token) : null;
  return {
    enabled,
    authEnabled,
    path: displayAgentKeyFile(path),
    url: apiUrl || defaultApiUrl(),
    active: enabled && (authEnabled ? session?.label === AGENT_KEY_LABEL : !!file),
    expiresAt: session?.label === AGENT_KEY_LABEL ? session.expiresAt : null,
  };
};

export const setAgentKeyEnabled = async (enabled) => {
  await updateSettingsWith((current) => ({
    ...current,
    secrets: { ...(current.secrets || {}), agentKey: { enabled: !!enabled } },
  }));
  await reconcile();
  return getAgentKeyStatus();
};

export const rotateAgentKey = async () => {
  if (!await isKeyEnabled() || !await isAuthEnabled()) {
    throw new ServerError('Turn on the agent API key (with a login password set) before rotating it', {
      status: 409,
      code: 'AGENT_KEY_INACTIVE',
    });
  }
  await reconcile({ force: true });
  return getAgentKeyStatus();
};

export const __testing = {
  reconcile,
  reset: () => {
    if (timer) clearInterval(timer);
    timer = null;
    apiUrl = null;
  },
};
