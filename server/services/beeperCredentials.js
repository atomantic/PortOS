/**
 * Vaulted Beeper credential store (fork issue #31, decision 6 on #11).
 *
 * The Beeper access token grants read AND send across every network the user
 * has bridged, and `DELETE /v1/chats/…/messages/…` defaults to unsending for
 * everyone — so it does NOT follow the `civitai.apiKey` plaintext-settings
 * precedent that root AGENTS.md's free-service carve-out covers. It follows the
 * Stacker News contract instead: AES-256-GCM ciphertext in Postgres via
 * `lib/vaultCrypto.js`, decrypted only at the moment of use, exposed to any
 * client as a boolean plus an expiry and never as a value.
 *
 * Honest limit, stated rather than overclaimed: `ensureVaultKey()` writes the
 * key to the install-root `.env`, on the same disk as the ciphertext. This
 * bounds DB dumps, backup snapshots (`data/settings.json` rides into every
 * one; the vault key does not) and accidental echoes. It does not defend
 * against an attacker who already has filesystem access.
 *
 * ONE row, `id = 'default'`: PortOS models one Beeper account per install (#1
 * charting decision 8). Reads are honest about the difference between "no
 * credential" (`null`) and "a credential that cannot be read" — a row whose
 * ciphertext fails to decrypt throws out of `decryptValue` rather than
 * degrading to "not configured", per #11 decision 8 ("a local read that THROWS
 * on a malformed store rather than returning false"). Silently reporting
 * not-configured would send a connected install back through the connect flow
 * and mint a second credential over a vault key that merely went missing.
 */

import { query } from '../lib/db.js';
import { decryptValue, encryptValue, ensureVaultKey } from '../lib/vaultCrypto.js';
import { getSettings } from './settings.js';

const CREDENTIAL_ID = 'default';

/** How the stored token was obtained. Mirrors the `source` CHECK in the DDL. */
export const BEEPER_TOKEN_SOURCES = ['oauth', 'pasted'];

/** The legacy plaintext call site (#29). Read-only — see `resolveBeeperToken`. */
const LEGACY_TOKEN_SOURCE = 'legacy-settings';

function normalizeToken(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * The stored credential, decrypted — `{ token, tokenExpiresAt, tokenScopes,
 * tokenSource, clientId }` — or `null` when this install has never connected.
 *
 * Every caller of this is server-side. The token it returns must never be
 * logged, echoed into an error message, or serialized into a response.
 */
export async function readBeeperCredential() {
  const result = await query(
    `SELECT token_enc, token_expires_at, scopes, source, client_id
     FROM beeper_credentials WHERE id = $1`,
    [CREDENTIAL_ID],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  return {
    // Deliberately unguarded: a corrupt row or a rotated vault key throws here
    // (see the module header) instead of masquerading as "no token".
    token: decryptValue(row.token_enc),
    tokenExpiresAt: toIsoOrNull(row.token_expires_at),
    tokenScopes: row.scopes ? String(row.scopes).split(/\s+/).filter(Boolean) : [],
    tokenSource: row.source,
    clientId: row.client_id || '',
  };
}

/**
 * Encrypt and store the ONE credential, replacing whatever was there.
 *
 * `expiresAt: null` is a real value, not an absence — it is the no-expiry token
 * only Beeper's own UI can mint (#11 decision 3), and it must overwrite an
 * earlier OAuth expiry rather than inheriting it.
 */
export async function saveBeeperCredential({ token, expiresAt = null, scopes = [], source, clientId = '' }) {
  const value = normalizeToken(token);
  if (!value) throw new Error('saveBeeperCredential requires a non-empty token');
  if (!BEEPER_TOKEN_SOURCES.includes(source)) {
    throw new Error(`saveBeeperCredential requires source one of ${BEEPER_TOKEN_SOURCES.join('|')}`);
  }
  await ensureVaultKey();
  const scopeText = Array.isArray(scopes) ? scopes.join(' ') : String(scopes || '');
  await query(
    `INSERT INTO beeper_credentials (id, token_enc, token_expires_at, scopes, source, client_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (id) DO UPDATE SET
       token_enc = EXCLUDED.token_enc,
       token_expires_at = EXCLUDED.token_expires_at,
       scopes = EXCLUDED.scopes,
       source = EXCLUDED.source,
       client_id = EXCLUDED.client_id,
       updated_at = NOW()`,
    [CREDENTIAL_ID, encryptValue(value), toIsoOrNull(expiresAt), scopeText, source, clientId || ''],
  );
  // Provenance and expiry only — never the value, never a masked prefix of it.
  console.log(`🔐 Beeper credential stored (source=${source}, expires=${toIsoOrNull(expiresAt) || 'never'})`);
  return { tokenConfigured: true, tokenExpiresAt: toIsoOrNull(expiresAt), tokenSource: source };
}

/** Forget the stored credential. Idempotent — reports whether a row existed. */
export async function deleteBeeperCredential() {
  const result = await query('DELETE FROM beeper_credentials WHERE id = $1', [CREDENTIAL_ID]);
  const deleted = (result?.rowCount ?? 0) > 0;
  if (deleted) console.log('🔌 Beeper credential deleted (disconnected)');
  return { deleted, tokenConfigured: false, tokenExpiresAt: null, tokenSource: null };
}

/**
 * The ONE token resolver `beeperClient` calls. Vault first; the legacy
 * plaintext `settings.beeper.token` (#29's original call site) second, and for
 * READS ONLY — nothing in PortOS writes that field any more, and the settings
 * route strips it from every response while carrying a hand-written one over
 * an unrelated save. An install that hand-edited a token into `settings.json`
 * before #31 keeps working; a fresh connect lands in the vault instead.
 *
 * Returns `{ token, tokenExpiresAt, tokenScopes, tokenSource }`, or `null`
 * when neither store holds one — distinct from a throw, which means the
 * vault itself is unreadable and the caller must not treat it as "not
 * connected". `tokenScopes` is always an array, `[]` when unknown — a pasted
 * token (#78) and the legacy plaintext path both have nothing to report.
 */
export async function resolveBeeperToken() {
  const vaulted = await readBeeperCredential();
  if (vaulted?.token) {
    return {
      token: vaulted.token,
      tokenExpiresAt: vaulted.tokenExpiresAt,
      tokenScopes: vaulted.tokenScopes,
      tokenSource: vaulted.tokenSource,
    };
  }
  const settings = await getSettings().catch(() => null);
  const legacy = normalizeToken(settings?.beeper?.token);
  if (!legacy) return null;
  return {
    token: legacy,
    tokenExpiresAt: toIsoOrNull(settings?.beeper?.tokenExpiresAt),
    tokenScopes: [],
    tokenSource: LEGACY_TOKEN_SOURCE,
  };
}
