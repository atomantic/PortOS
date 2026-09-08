import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({ query: vi.fn() }));
vi.mock('../lib/vaultCrypto.js', () => ({
  ensureVaultKey: vi.fn().mockResolvedValue({ generated: false }),
  encryptValue: vi.fn(),
  decryptValue: vi.fn(),
}));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));

import { query } from '../lib/db.js';
import { decryptValue, encryptValue, ensureVaultKey } from '../lib/vaultCrypto.js';
import { getSettings } from './settings.js';
import {
  deleteBeeperCredential, readBeeperCredential,
  resolveBeeperToken, saveBeeperCredential,
} from './beeperCredentials.js';

// A placeholder that is obviously not a real credential, per the repo's
// placeholders-only rule for anything that lands in a committed file.
const TOKEN = 'example-beeper-token';
const CIPHERTEXT = 'v1:aXY=:dGFn:Y3Q=';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(encryptValue).mockReturnValue(CIPHERTEXT);
  vi.mocked(decryptValue).mockReturnValue(TOKEN);
  vi.mocked(getSettings).mockResolvedValue({});
});

describe('saveBeeperCredential', () => {
  it('encrypts before writing and never puts the token in the row or the log', async () => {
    const logs = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((line) => logs.push(String(line)));
    vi.mocked(query).mockResolvedValue({ rowCount: 1 });

    const result = await saveBeeperCredential({
      token: TOKEN, expiresAt: '2026-12-01T00:00:00.000Z', scopes: ['read', 'write'], source: 'oauth', clientId: 'client-1',
    });

    expect(ensureVaultKey).toHaveBeenCalled();
    expect(encryptValue).toHaveBeenCalledWith(TOKEN);
    const params = vi.mocked(query).mock.calls[0][1];
    expect(params).toContain(CIPHERTEXT);
    expect(params).not.toContain(TOKEN);
    expect(params).toContain('read write');
    expect(result).toEqual({ tokenConfigured: true, tokenExpiresAt: '2026-12-01T00:00:00.000Z', tokenSource: 'oauth' });
    expect(logs.join('\n')).not.toContain(TOKEN);
    logSpy.mockRestore();
  });

  // `expiresAt: null` is the no-expiry pasted token (#11 decision 3), a real
  // value that must overwrite an earlier OAuth expiry rather than be treated as
  // "field absent, keep what was there".
  it('stores a null expiry for a pasted token rather than inheriting the previous one', async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: 1 });
    const result = await saveBeeperCredential({ token: TOKEN, expiresAt: null, scopes: [], source: 'pasted' });
    expect(vi.mocked(query).mock.calls[0][1][2]).toBeNull();
    expect(result.tokenExpiresAt).toBeNull();
    expect(result.tokenSource).toBe('pasted');
  });

  it('refuses an unknown provenance rather than writing an unclassified credential', async () => {
    await expect(saveBeeperCredential({ token: TOKEN, source: 'guessed' })).rejects.toThrow(/source/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('readBeeperCredential', () => {
  it('decrypts the stored row into token, expiry, scopes and provenance', async () => {
    vi.mocked(query).mockResolvedValue({
      rows: [{
        token_enc: CIPHERTEXT,
        token_expires_at: new Date('2026-12-01T00:00:00.000Z'),
        scopes: 'read write',
        source: 'oauth',
        client_id: 'client-1',
      }],
    });
    await expect(readBeeperCredential()).resolves.toEqual({
      token: TOKEN,
      tokenExpiresAt: '2026-12-01T00:00:00.000Z',
      tokenScopes: ['read', 'write'],
      tokenSource: 'oauth',
      clientId: 'client-1',
    });
  });

  it('returns null (never throws) when this install has never connected', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await expect(readBeeperCredential()).resolves.toBeNull();
  });

  // #11 decision 8: a local read THROWS on a malformed store rather than
  // returning false. Reporting "not configured" for a row that merely cannot be
  // decrypted would send a connected install back through connect and mint a
  // second credential over a vault key that only went missing.
  it('throws when the stored ciphertext cannot be decrypted, instead of reporting no credential', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ token_enc: 'corrupt', source: 'oauth', scopes: '' }] });
    vi.mocked(decryptValue).mockImplementation(() => { throw new Error('Malformed vault ciphertext'); });
    await expect(readBeeperCredential()).rejects.toThrow(/vault ciphertext/);
  });
});

describe('resolveBeeperToken', () => {
  it('prefers the vaulted credential over anything in settings, scopes included', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ token_enc: CIPHERTEXT, token_expires_at: null, scopes: 'read write', source: 'oauth', client_id: '' }] });
    vi.mocked(getSettings).mockResolvedValue({ beeper: { token: 'legacy-plaintext-token' } });
    await expect(resolveBeeperToken()).resolves.toMatchObject({ token: TOKEN, tokenSource: 'oauth', tokenScopes: ['read', 'write'] });
    expect(getSettings).not.toHaveBeenCalled();
  });

  // The #29 call site stays readable so an install that hand-edited a token
  // into settings.json before the vault existed keeps working. Nothing writes
  // it any more. It has no scopes to report — fork issue #78's "unknown"
  // sentinel, same as a pasted token.
  it('falls back to the legacy plaintext settings token for READS, with tokenScopes: []', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    vi.mocked(getSettings).mockResolvedValue({
      beeper: { token: 'legacy-plaintext-token', tokenExpiresAt: '2026-12-01T00:00:00.000Z' },
    });
    await expect(resolveBeeperToken()).resolves.toEqual({
      token: 'legacy-plaintext-token',
      tokenExpiresAt: '2026-12-01T00:00:00.000Z',
      tokenScopes: [],
      tokenSource: 'legacy-settings',
    });
  });

  it('resolves null when neither store holds a credential', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [] });
    await expect(resolveBeeperToken()).resolves.toBeNull();
  });
});

describe('deleteBeeperCredential', () => {
  it('reports what it removed and is idempotent', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });
    await expect(deleteBeeperCredential()).resolves.toMatchObject({ deleted: true, tokenConfigured: false });
    await expect(deleteBeeperCredential()).resolves.toMatchObject({ deleted: false, tokenConfigured: false });
  });
});
