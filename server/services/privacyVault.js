/**
 * Privacy Vault — encrypted-at-rest PII records (issue #2140, epic #2138).
 *
 * db-primary Postgres per docs/STORAGE.md: one row per identity fact in
 * `privacy_vault_records` (dedicated columns — the records are relational and
 * queried by type), consent audit rows in `privacy_consents`. Machine-local:
 * NO federation, NO tombstones (deferred child issue #2148).
 *
 * Encryption contract:
 * - plaintext is NEVER stored — every write computes `value_enc` (AES-256-GCM
 *   via lib/vaultCrypto.js) + a per-type `masked_value` for list/read display.
 * - plaintext is NEVER logged — log ids/types only, single-line emoji style.
 * - reads return masked values; `revealValue(id)` is the ONE decrypt path.
 *
 * The first vault record creation writes an explicit consent row (scope
 * `pii_vault`) — the audit trail the later broker opt-out engine builds on.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  encryptValue, decryptValue, ensureVaultKey, isVaultKeyConfigured, maskValue,
} from '../lib/vaultCrypto.js';
import { PRIVACY_SENSITIVE_TYPES, PRIVACY_SCAN_DEFAULT_TYPES } from '../lib/privacyValidation.js';

// Everything EXCEPT value_enc — list/read responses never carry ciphertext.
// DATE columns come back via to_char as plain 'YYYY-MM-DD' strings: node-postgres
// otherwise parses DATE into a local-midnight JS Date, and re-serializing that
// through toISOString() shifts the date back a day in UTC+N timezones.
const RECORD_COLUMNS = `id, type, label, masked_value, status,
  to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
  to_char(valid_to, 'YYYY-MM-DD') AS valid_to,
  share_with_twin, use_for_scans, notes, created_at, updated_at`;

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    maskedValue: row.masked_value,
    status: row.status,
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
    shareWithTwin: row.share_with_twin,
    useForScans: row.use_for_scans,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Effective use_for_scans for a record: sensitive types are HARD false (the
 * schema already rejects an explicit true; this re-enforces it), otherwise the
 * caller's explicit choice wins, otherwise the per-type default (true for
 * legal_name/email/phone/address).
 */
export function resolveUseForScans(type, requested) {
  if (PRIVACY_SENSITIVE_TYPES.includes(type)) return false;
  if (typeof requested === 'boolean') return requested;
  return PRIVACY_SCAN_DEFAULT_TYPES.includes(type);
}

/** Write an explicit consent row (subject defaults to 'self' for v1). */
export async function recordConsent({ subject = 'self', scope, method }) {
  const id = randomUUID();
  await query(
    `INSERT INTO privacy_consents (id, subject, scope, method, granted_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [id, subject, scope, method],
  );
  console.log(`📝 Recorded privacy consent ${id} (scope=${scope}, method=${method})`);
  return { id, subject, scope, method };
}

export async function createVaultRecord(input) {
  await ensureVaultKey(); // self-heal a missing key on first write
  const id = randomUUID();
  const useForScans = resolveUseForScans(input.type, input.useForScans);
  // First-ever record ⇒ write the consent row (audit trail for the opt-out engine).
  const { rows: countRows } = await query(`SELECT COUNT(*)::int AS n FROM privacy_vault_records`);
  const isFirstRecord = countRows[0].n === 0;
  const { rows } = await query(
    `INSERT INTO privacy_vault_records
       (id, type, label, value_enc, masked_value, status, valid_from, valid_to,
        share_with_twin, use_for_scans, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())
     RETURNING ${RECORD_COLUMNS}`,
    [
      id, input.type, input.label,
      encryptValue(input.value), maskValue(input.type, input.value),
      input.status ?? 'current',
      input.validFrom ?? null, input.validTo ?? null,
      input.shareWithTwin === true, useForScans,
      input.notes ?? '',
    ],
  );
  if (isFirstRecord) {
    await recordConsent({ scope: 'pii_vault', method: 'vault-record-create' });
  }
  console.log(`🔐 Created vault record ${id} (type=${input.type})`);
  return rowToRecord(rows[0]);
}

export async function listVaultRecords({ type } = {}) {
  const { rows } = type
    ? await query(`SELECT ${RECORD_COLUMNS} FROM privacy_vault_records WHERE type = $1 ORDER BY created_at DESC`, [type])
    : await query(`SELECT ${RECORD_COLUMNS} FROM privacy_vault_records ORDER BY created_at DESC`);
  return rows.map(rowToRecord);
}

export async function getVaultRecord(id) {
  const { rows } = await query(`SELECT ${RECORD_COLUMNS} FROM privacy_vault_records WHERE id = $1`, [id]);
  return rowToRecord(rows[0]);
}

export async function updateVaultRecord(id, patch) {
  return withTransaction(async (client) => {
    // Row lock: label PATCH + value PATCH from different UI affordances can
    // race a read-modify-write; FOR UPDATE serializes writes to one record.
    const sel = await client.query(
      `SELECT id, type FROM privacy_vault_records WHERE id = $1 FOR UPDATE`, [id],
    );
    const existing = sel.rows[0];
    if (!existing) throw new ServerError('Vault record not found', { status: 404, code: 'NOT_FOUND' });
    if (patch.useForScans === true && PRIVACY_SENSITIVE_TYPES.includes(existing.type)) {
      throw new ServerError(
        `useForScans cannot be true for sensitive type "${existing.type}"`,
        { status: 400, code: 'SENSITIVE_TYPE_SCAN_FORBIDDEN' },
      );
    }
    const sets = [];
    const params = [];
    const add = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (patch.value !== undefined) {
      await ensureVaultKey();
      add('value_enc', encryptValue(patch.value));
      add('masked_value', maskValue(existing.type, patch.value));
    }
    if (patch.label !== undefined) add('label', patch.label);
    if (patch.status !== undefined) add('status', patch.status);
    if (patch.validFrom !== undefined) add('valid_from', patch.validFrom);
    if (patch.validTo !== undefined) add('valid_to', patch.validTo);
    if (patch.shareWithTwin !== undefined) add('share_with_twin', patch.shareWithTwin);
    if (patch.useForScans !== undefined) add('use_for_scans', resolveUseForScans(existing.type, patch.useForScans));
    if (patch.notes !== undefined) add('notes', patch.notes);
    params.push(id);
    const { rows } = await client.query(
      `UPDATE privacy_vault_records SET ${[...sets, 'updated_at = NOW()'].join(', ')}
       WHERE id = $${params.length} RETURNING ${RECORD_COLUMNS}`,
      params,
    );
    console.log(`🔐 Updated vault record ${id} (type=${existing.type})`);
    return rowToRecord(rows[0]);
  });
}

export async function deleteVaultRecord(id) {
  const { rows } = await query(`DELETE FROM privacy_vault_records WHERE id = $1 RETURNING id, type`, [id]);
  if (!rows[0]) throw new ServerError('Vault record not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🗑️ Deleted vault record ${id} (type=${rows[0].type})`);
  return { ok: true };
}

/** The ONE decrypt path — explicit reveal. Returns plaintext; logs id/type only. */
export async function revealValue(id) {
  const { rows } = await query(`SELECT id, type, value_enc FROM privacy_vault_records WHERE id = $1`, [id]);
  if (!rows[0]) throw new ServerError('Vault record not found', { status: 404, code: 'NOT_FOUND' });
  const value = decryptValue(rows[0].value_enc);
  console.log(`🔓 Revealed vault record ${id} (type=${rows[0].type})`);
  return { id: rows[0].id, type: rows[0].type, value };
}

/** Doctor-style readout: { keyConfigured, recordCounts: { <type>: n } }. */
export async function getVaultStatus() {
  const { rows } = await query(
    `SELECT type, COUNT(*)::int AS n FROM privacy_vault_records GROUP BY type ORDER BY type`,
  );
  const recordCounts = {};
  for (const row of rows) recordCounts[row.type] = row.n;
  return { keyConfigured: isVaultKeyConfigured(), recordCounts };
}
