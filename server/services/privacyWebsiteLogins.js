/**
 * Privacy Vault website logins — origin-bound encrypted website credentials with optional TOTP seeds (#17397).
 *
 * Storage: `db-primary` — rows in `privacy_vault_records` with type
 * `website_login`; machine-local and never federated, like every vault record
 * (ADR docs/decisions/2026-08-08-privacy-records-machine-local.md).
 *
 * The username, password and parsed TOTP config live ONLY inside `value_enc`
 * (AES-256-GCM over a versioned JSON payload). The queryable columns hold
 * non-secret lookup metadata — `label`, `login_origins` (exact normalized
 * origins), `masked_value` (masked username) and `has_totp` — so listing logins
 * never decrypts. `website_login` is a sensitive type: never shared with the
 * twin, never used for scans, never decrypted for scrubbing.
 *
 * No endpoint returns the decrypted payload. `readWebsiteLoginForFill` exists
 * solely for the host-side model-blind browser fill (services/browserVaultFill.js);
 * the generic reveal refuses this type. Logs carry ids and counts only.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { encryptValue, decryptValue, ensureVaultKey, maskValue } from '../lib/vaultCrypto.js';
import { PRIVACY_WEBSITE_LOGIN_TYPE } from '../lib/privacyConstants.js';
import { parseTotpSetupKey } from '../lib/totp.js';
import { normalizeLoginOrigin } from '../lib/websiteLoginValidation.js';
import { resolveSubjectId, assertSubject, recordConsent } from './privacySubjects.js';
import { deleteVaultRecord, needsPiiVaultConsent } from './privacyVault.js';

const PAYLOAD_VERSION = 1;
const LOGIN_COLUMNS = 'id, subject_id, label, masked_value, login_origins, has_totp, notes, created_at, updated_at';

const notFound = () => new ServerError('Website login not found', { status: 404, code: 'WEBSITE_LOGIN_NOT_FOUND' });

function rowToLogin(row) {
  if (!row) return null;
  return {
    id: row.id,
    subjectId: row.subject_id,
    label: row.label,
    origins: row.login_origins ?? [],
    maskedUsername: row.masked_value,
    hasTotp: row.has_totp === true,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const maskUsername = (username) => maskValue(username.includes('@') ? 'email' : 'custom', username);

function normalizeOrigins(origins) {
  const normalized = origins.map(normalizeLoginOrigin);
  if (normalized.length === 0 || normalized.includes(null)) {
    throw new ServerError('Every login origin must be an http(s) origin such as https://example.com', { status: 400, code: 'INVALID_LOGIN_ORIGIN' });
  }
  return [...new Set(normalized)];
}

function parseTotp(setupKey) {
  try {
    return parseTotpSetupKey(setupKey);
  } catch (error) {
    // parseTotpSetupKey messages never echo the key, so this one is safe to return.
    throw new ServerError(error.message, { status: 400, code: 'INVALID_TOTP_SECRET' });
  }
}

// Refuses anything decodeSecrets could not read back, so no write can leave a
// row that every later fill and secret update would reject as unreadable.
function encodeSecrets({ username, password, totp }) {
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    throw new ServerError('A website login needs a username and a password', { status: 400, code: 'WEBSITE_LOGIN_INVALID' });
  }
  return encryptValue(JSON.stringify({ v: PAYLOAD_VERSION, username, password, totp: totp ?? null }));
}

function decodeSecrets(valueEnc) {
  let parsed = null;
  // JSON.parse's SyntaxError quotes the input it failed on, so its message must
  // never escape: the input is a decrypted credential.
  try { parsed = JSON.parse(decryptValue(valueEnc)); } catch { parsed = null; }
  if (parsed?.v !== PAYLOAD_VERSION || typeof parsed.username !== 'string' || typeof parsed.password !== 'string') {
    throw new ServerError('Website login payload is unreadable', { status: 500, code: 'WEBSITE_LOGIN_UNREADABLE' });
  }
  return { username: parsed.username, password: parsed.password, totp: parsed.totp ?? null };
}

export async function createWebsiteLogin(input) {
  const totp = input.totpSecret ? parseTotp(input.totpSecret) : null;
  const origins = normalizeOrigins(input.origins);
  await ensureVaultKey();
  const valueEnc = encodeSecrets({ username: input.username, password: input.password, totp });
  const subjectId = (await assertSubject(input.subjectId)).id;
  // Consent precedes the secret it covers: a failed consent write stores no
  // credential, and a failed insert after it leaves only the audit fact, which
  // a retry reuses rather than duplicating.
  if (await needsPiiVaultConsent(subjectId)) {
    await recordConsent({ subjectId, scope: 'pii_vault', method: 'website-login-create' });
  }
  const id = randomUUID();
  const { rows } = await query(
    `INSERT INTO privacy_vault_records
       (id, subject_id, type, label, value_enc, masked_value, status, share_with_twin, use_for_scans,
        notes, login_origins, has_totp, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'current', FALSE, FALSE, $7, $8::text[], $9, NOW(), NOW())
     RETURNING ${LOGIN_COLUMNS}`,
    [
      id, subjectId, PRIVACY_WEBSITE_LOGIN_TYPE, input.label,
      valueEnc, maskUsername(input.username), input.notes ?? '', origins, totp !== null,
    ],
  );
  console.log(`🔐 Created website login ${id} (subject=${subjectId}, origins=${origins.length}, totp=${totp ? 'yes' : 'no'})`);
  return rowToLogin(rows[0]);
}

/**
 * Metadata-only listing. Scoped to one subject (default `self`) for the Privacy
 * Center; `allSubjects` lists every household member's logins as fill
 * candidates for the operator's browser. `origin` narrows to logins allowed on
 * exactly that origin.
 */
export async function listWebsiteLogins({ subjectId, origin, allSubjects = false } = {}) {
  const params = [PRIVACY_WEBSITE_LOGIN_TYPE];
  const clauses = ['type = $1'];
  if (!allSubjects) {
    params.push(resolveSubjectId(subjectId));
    clauses.push(`subject_id = $${params.length}`);
  }
  if (origin !== undefined) {
    params.push(normalizeOrigins([origin])[0]);
    clauses.push(`$${params.length} = ANY(login_origins)`);
  }
  const { rows } = await query(
    `SELECT ${LOGIN_COLUMNS} FROM privacy_vault_records
     WHERE ${clauses.join(' AND ')} ORDER BY label, created_at`,
    params,
  );
  return rows.map(rowToLogin);
}

export async function getWebsiteLogin(id) {
  const { rows } = await query(
    `SELECT ${LOGIN_COLUMNS} FROM privacy_vault_records WHERE id = $1 AND type = $2`, [id, PRIVACY_WEBSITE_LOGIN_TYPE],
  );
  return rowToLogin(rows[0]);
}

/**
 * Partial update. An absent key keeps the stored value; `totpSecret` null or
 * empty removes the seed. Changing any secret decrypts and re-encrypts the
 * payload under a row lock so concurrent edits can't drop each other's fields.
 */
export async function updateWebsiteLogin(id, patch) {
  const totpChanged = patch.totpSecret !== undefined;
  const nextTotp = totpChanged && patch.totpSecret ? parseTotp(patch.totpSecret) : null;
  const secretsChanged = patch.username !== undefined || patch.password !== undefined || totpChanged;
  const origins = patch.origins !== undefined ? normalizeOrigins(patch.origins) : undefined;
  if (secretsChanged) await ensureVaultKey();
  return withTransaction(async (client) => {
    const sel = await client.query(
      `SELECT id, value_enc FROM privacy_vault_records WHERE id = $1 AND type = $2 FOR UPDATE`, [id, PRIVACY_WEBSITE_LOGIN_TYPE],
    );
    const existing = sel.rows[0];
    if (!existing) throw notFound();
    const sets = [];
    const params = [];
    const add = (column, value, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (secretsChanged) {
      const current = decodeSecrets(existing.value_enc);
      const next = {
        username: patch.username ?? current.username,
        password: patch.password ?? current.password,
        totp: totpChanged ? nextTotp : current.totp,
      };
      add('value_enc', encodeSecrets(next));
      add('masked_value', maskUsername(next.username));
      add('has_totp', next.totp !== null);
    }
    if (patch.label !== undefined) add('label', patch.label);
    if (patch.notes !== undefined) add('notes', patch.notes);
    if (origins !== undefined) add('login_origins', origins, '::text[]');
    params.push(id);
    const { rows } = await client.query(
      `UPDATE privacy_vault_records SET ${[...sets, 'updated_at = NOW()'].join(', ')}
       WHERE id = $${params.length} RETURNING ${LOGIN_COLUMNS}`,
      params,
    );
    console.log(`🔐 Updated website login ${id}${secretsChanged ? ' (secrets re-encrypted)' : ''}`);
    return rowToLogin(rows[0]);
  });
}

export async function deleteWebsiteLogin(id) {
  if (!(await getWebsiteLogin(id))) throw notFound();
  return deleteVaultRecord(id);
}

/**
 * Decrypt one login for the host-side browser fill ONLY. The returned
 * plaintext must never reach a response, log, prompt or tool result.
 */
export async function readWebsiteLoginForFill(id) {
  const { rows } = await query(
    `SELECT id, login_origins, value_enc FROM privacy_vault_records WHERE id = $1 AND type = $2`, [id, PRIVACY_WEBSITE_LOGIN_TYPE],
  );
  if (!rows[0]) throw notFound();
  const secrets = decodeSecrets(rows[0].value_enc);
  console.log(`🔓 Decrypted website login ${id} for a browser fill`);
  return { id: rows[0].id, origins: rows[0].login_origins ?? [], ...secrets };
}
