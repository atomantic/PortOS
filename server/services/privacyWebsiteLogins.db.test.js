/**
 * Postgres-backed round-trip for Privacy Vault website logins (#17397).
 *
 * Pins the model-blind storage contract at the service boundary: the raw row
 * holds no plaintext username/password/seed, listing returns metadata only,
 * the generic vault list/update/reveal/change paths refuse the type, and only
 * the fill-only reader decrypts. Skips cleanly without a reachable DB; runs via
 * `npm run test:db` (→ portos_test) ONLY.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

vi.mock('./privacyPromptScrub.js', () => ({ scrubRevokedPrivacyFacts: vi.fn() }));

// A known test key, set only while this suite actually runs (before any service
// import, so ensureVaultKey never provisions the install's real .env) and
// restored even when cleanup fails.
const HEX_KEY = 'd'.repeat(64);
const originalKey = process.env.PRIVACY_VAULT_KEY;

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name = 'privacy_vault_records' AND column_name = 'login_origins') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'privacy_vault_records.login_origins not present';
  }
}

const runDb = requireDbOrSkip('services/privacyWebsiteLogins.db.test', dbReady, skipReason);

const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const USERNAME = 'alice.example@example.com';
const PASSWORD = 'pw-correct-horse-battery-9271';

describe.skipIf(!runDb)('privacy website logins DB round-trip', () => {
  let logins;
  let vault;
  let changes;
  let loginId = '';
  const created = [];

  beforeAll(async () => {
    process.env.PRIVACY_VAULT_KEY = HEX_KEY;
    logins = await import('./privacyWebsiteLogins.js');
    vault = await import('./privacyVault.js');
    changes = await import('./privacyChanges.js');
  });

  afterAll(async () => {
    try {
      // Only rows this file created: portos_test is shared across suites.
      for (const id of created) {
        await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
      }
      await close();
    } finally {
      if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
      else process.env.PRIVACY_VAULT_KEY = originalKey;
    }
  });

  it('stores only ciphertext plus non-secret metadata and lists metadata only', async () => {
    const login = await logins.createWebsiteLogin({
      label: 'Example portal', origins: ['https://example.com', 'https://id.example.com'],
      username: USERNAME, password: PASSWORD, totpSecret: SEED,
    });
    created.push(login.id);
    loginId = login.id;
    expect(login).toMatchObject({
      label: 'Example portal', origins: ['https://example.com', 'https://id.example.com'], hasTotp: true,
    });
    expect(login.maskedUsername).toBe('a•••@example.com');

    const { rows } = await query(`SELECT * FROM privacy_vault_records WHERE id = $1`, [login.id]);
    const raw = JSON.stringify(rows[0]);
    for (const secret of [USERNAME, PASSWORD, SEED]) expect(raw).not.toContain(secret);
    expect(rows[0]).toMatchObject({ type: 'website_login', share_with_twin: false, use_for_scans: false });

    const listed = await logins.listWebsiteLogins({ origin: 'https://id.example.com/signin' });
    expect(listed.map((row) => row.id)).toContain(login.id);
    const listedJson = JSON.stringify(listed);
    for (const secret of [USERNAME, PASSWORD, SEED]) expect(listedJson).not.toContain(secret);
    // Exact origin only — no suffix, scheme or subdomain matching.
    for (const origin of ['http://example.com', 'https://www.example.com', 'https://example.com:8443']) {
      expect((await logins.listWebsiteLogins({ origin })).map((row) => row.id)).not.toContain(login.id);
    }
  });

  it('decrypts only through the fill reader', async () => {
    const forFill = await logins.readWebsiteLoginForFill(loginId);
    expect(forFill).toMatchObject({ username: USERNAME, password: PASSWORD, totp: { secret: SEED, digits: 6, period: 30 } });
  });

  it('keeps website logins out of every generic vault path', async () => {
    expect((await vault.listVaultRecords()).map((row) => row.id)).not.toContain(loginId);
    await expect(vault.revealValue(loginId)).rejects.toMatchObject({ code: 'WEBSITE_LOGIN_NOT_REVEALABLE' });
    await expect(vault.updateVaultRecord(loginId, { shareWithTwin: true })).rejects.toMatchObject({ code: 'WEBSITE_LOGIN_MANAGED_SEPARATELY' });
    await expect(changes.declareChange({ vaultRecordId: loginId, replacement: { label: 'x', value: 'y' } }))
      .rejects.toMatchObject({ code: 'WEBSITE_LOGIN_CHANGE_FORBIDDEN' });
  });

  it('merges partial secret updates and clears the seed on null', async () => {
    const renamed = await logins.updateWebsiteLogin(loginId, { label: 'Renamed', origins: ['https://example.com/login'] });
    expect(renamed).toMatchObject({ label: 'Renamed', origins: ['https://example.com'], hasTotp: true });

    const rotated = await logins.updateWebsiteLogin(loginId, { password: 'pw-rotated-0042', totpSecret: null });
    expect(rotated.hasTotp).toBe(false);
    const forFill = await logins.readWebsiteLoginForFill(loginId);
    expect(forFill).toMatchObject({ username: USERNAME, password: 'pw-rotated-0042', totp: null });
  });

  it('refuses to store a payload it could not read back', async () => {
    await expect(logins.createWebsiteLogin({ label: 'Broken', origins: ['https://example.com'], username: USERNAME }))
      .rejects.toMatchObject({ code: 'WEBSITE_LOGIN_INVALID', status: 400 });
  });

  it('refuses an unreadable payload without echoing its plaintext', async () => {
    const { encryptValue } = await import('../lib/vaultCrypto.js');
    await query(`UPDATE privacy_vault_records SET value_enc = $1 WHERE id = $2`, [encryptValue('not-json-plaintext-7731'), loginId]);
    const error = await logins.readWebsiteLoginForFill(loginId).catch((e) => e);
    expect(error.code).toBe('WEBSITE_LOGIN_UNREADABLE');
    expect(error.message).not.toContain('not-json-plaintext-7731');
  });

  it('deletes through the login endpoint and 404s for a non-login record', async () => {
    const other = await vault.createVaultRecord({ type: 'custom', label: 'Not a login', value: 'plain fact' });
    created.push(other.id);
    await expect(logins.deleteWebsiteLogin(other.id)).rejects.toMatchObject({ code: 'WEBSITE_LOGIN_NOT_FOUND' });
    await logins.deleteWebsiteLogin(loginId);
    expect(await logins.getWebsiteLogin(loginId)).toBeNull();
  });
});
