/**
 * The local agent API key: a plaintext session token in a file under the user's
 * home directory. What has to hold:
 *   - off means no file and no live agent-key session (turning it off revokes);
 *   - on means exactly one live agent-key session whose token is in the file,
 *     the file mode 0600, and a still-current key is never re-minted;
 *   - a key whose session was dropped (password rotation) or is about to
 *     expire is replaced, and the old session revoked;
 *   - the status the Settings UI reads never carries the token.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const sessions = new Map(); // token → { id, label, expiresAt }
let nextId = 0;
let authEnabled = true;
let settings = {};

vi.mock('./auth.js', () => ({
  authEvents: new EventEmitter(),
  isAuthEnabled: async () => authEnabled,
  createSession: async ({ label }) => {
    nextId += 1;
    const token = `tok-${nextId}`;
    const entry = { id: `id-${nextId}`, label, expiresAt: Date.now() + 30 * 86_400_000 };
    sessions.set(token, entry);
    return { token, expiresAt: entry.expiresAt, id: entry.id };
  },
  describeSession: async (token) => sessions.get(token) ?? null,
  revokeSessionsByLabel: async (label, { keepId = null } = {}) => {
    for (const [token, entry] of sessions) {
      if (entry.label === label && entry.id !== keepId) sessions.delete(token);
    }
  },
}));

vi.mock('./settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: async () => settings,
  updateSettingsWith: async (mutate) => { settings = await mutate(settings); },
}));

const { AGENT_KEY_LABEL, getAgentKeyStatus, initAgentKey, rotateAgentKey, setAgentKeyEnabled, __testing } = await import('./agentKey.js');

const liveKeySessions = () => [...sessions.values()].filter((s) => s.label === AGENT_KEY_LABEL);

describe('agent API key', () => {
  let dir;
  let keyFile;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'portos-agent-key-'));
    keyFile = join(dir, 'nested', 'agent-key.json');
    vi.stubEnv('PORTOS_AGENT_KEY_FILE', keyFile);
    sessions.clear();
    nextId = 0;
    authEnabled = true;
    settings = {};
    __testing.reset();
    initAgentKey({ httpsEnabled: true, port: 5555 });
    await __testing.reconcile();
  });

  afterEach(async () => {
    __testing.reset();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  const readKey = async () => JSON.parse(await readFile(keyFile, 'utf8'));

  it('writes nothing while off', async () => {
    await expect(stat(keyFile)).rejects.toThrow();
    expect(liveKeySessions()).toHaveLength(0);
    expect(await getAgentKeyStatus()).toMatchObject({ enabled: false, active: false });
  });

  it('turning it on writes one live token to a 0600 file, and a current key is kept', async () => {
    await setAgentKeyEnabled(true);
    const key = await readKey();
    expect(key).toMatchObject({ url: 'http://127.0.0.1:5553', token: 'tok-1' });
    // Windows has no POSIX mode bits; stat reports 0o666 whatever was asked.
    if (process.platform !== 'win32') expect((await stat(keyFile)).mode & 0o777).toBe(0o600);
    expect(liveKeySessions()).toHaveLength(1);

    await __testing.reconcile();
    expect((await readKey()).token).toBe('tok-1');

    const status = await getAgentKeyStatus();
    expect(status).toMatchObject({ enabled: true, active: true });
    expect(JSON.stringify(status)).not.toContain('tok-1');
  });

  it('replaces a key whose session was revoked, e.g. by a password change', async () => {
    await setAgentKeyEnabled(true);
    sessions.clear();
    await __testing.reconcile();
    expect((await readKey()).token).toBe('tok-2');
    expect(liveKeySessions()).toHaveLength(1);
  });

  it('re-mints a key about to expire and revokes the old session', async () => {
    await setAgentKeyEnabled(true);
    sessions.get('tok-1').expiresAt = Date.now() + 86_400_000;
    await __testing.reconcile();
    expect((await readKey()).token).toBe('tok-2');
    expect(sessions.has('tok-1')).toBe(false);
  });

  it('rotate replaces a current key; turning off revokes it and deletes the file', async () => {
    await setAgentKeyEnabled(true);
    await rotateAgentKey();
    expect((await readKey()).token).toBe('tok-2');
    expect(liveKeySessions()).toHaveLength(1);

    await setAgentKeyEnabled(false);
    await expect(stat(keyFile)).rejects.toThrow();
    expect(liveKeySessions()).toHaveLength(0);
  });

  it('refuses to rotate while off', async () => {
    await expect(rotateAgentKey()).rejects.toMatchObject({ status: 409, code: 'AGENT_KEY_INACTIVE' });
  });

  it('writes no token on an install without a password', async () => {
    authEnabled = false;
    await setAgentKeyEnabled(true);
    expect(await readKey()).toMatchObject({ url: 'http://127.0.0.1:5553', token: null });
    expect(sessions.size).toBe(0);
  });
});
