/**
 * Privacy Vault — encrypted-at-rest PII records (issue #2140, epic #2138).
 *
 * db-primary Postgres per docs/STORAGE.md: one row per identity fact in
 * `privacy_vault_records` (dedicated columns — the records are relational and
 * queried by type), consent audit rows in `privacy_consents`. Machine-local:
 * NO federation, NO tombstones. This is a product GUARANTEE, not a deferred
 * feature — the vault's contents have never traversed a network from PortOS.
 * See ADR docs/decisions/2026-08-08-privacy-records-machine-local.md (#2148);
 * a second machine gets the vault via backup restore + a manual key copy.
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
import { resolveSubjectId, assertSubject, recordConsent } from './privacySubjects.js';

// Re-exported so the pre-#3658 deep import `privacyVault.recordConsent` keeps
// working; the consent trail itself now lives with the subjects that own it.
export { recordConsent };

// Everything EXCEPT value_enc — list/read responses never carry ciphertext.
// DATE columns come back via to_char as plain 'YYYY-MM-DD' strings: node-postgres
// otherwise parses DATE into a local-midnight JS Date, and re-serializing that
// through toISOString() shifts the date back a day in UTC+N timezones.
const RECORD_COLUMNS = `id, subject_id, type, label, masked_value, status,
  to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
  to_char(valid_to, 'YYYY-MM-DD') AS valid_to,
  share_with_twin, use_for_scans, notes, created_at, updated_at`;

function rowToRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    subjectId: row.subject_id,
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

export async function createVaultRecord(input) {
  await ensureVaultKey(); // self-heal a missing key on first write
  // A bogus subjectId must 404 up front rather than trip a raw FK violation.
  const subjectId = (await assertSubject(input.subjectId)).id;
  const id = randomUUID();
  const useForScans = resolveUseForScans(input.type, input.useForScans);
  // First record FOR THIS SUBJECT ⇒ write the consent row (audit trail for the
  // opt-out engine). Scoped per subject so a household member added directly
  // through the vault still gets a consent row of their own rather than riding
  // on `self`'s.
  const { rows: countRows } = await query(
    `SELECT COUNT(*)::int AS n FROM privacy_consents WHERE subject_id = $1`, [subjectId],
  );
  const needsConsent = countRows[0].n === 0;
  const { rows } = await query(
    `INSERT INTO privacy_vault_records
       (id, subject_id, type, label, value_enc, masked_value, status, valid_from, valid_to,
        share_with_twin, use_for_scans, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
     RETURNING ${RECORD_COLUMNS}`,
    [
      id, subjectId, input.type, input.label,
      encryptValue(input.value), maskValue(input.type, input.value),
      input.status ?? 'current',
      input.validFrom ?? null, input.validTo ?? null,
      input.shareWithTwin === true, useForScans,
      input.notes ?? '',
    ],
  );
  if (needsConsent) {
    await recordConsent({ subjectId, scope: 'pii_vault', method: 'vault-record-create' });
  }
  console.log(`🔐 Created vault record ${id} (subject=${subjectId}, type=${input.type})`);
  return rowToRecord(rows[0]);
}

export async function listVaultRecords({ type, subjectId } = {}) {
  // Always scoped to ONE subject — an unscoped list would mix two household
  // members' identity facts into one table, which is exactly what this scoping
  // exists to prevent. Omitting subjectId means `self`, so every pre-#3658
  // caller is unchanged.
  const params = [resolveSubjectId(subjectId)];
  const clauses = ['subject_id = $1'];
  if (type) { params.push(type); clauses.push(`type = $${params.length}`); }
  const { rows } = await query(
    `SELECT ${RECORD_COLUMNS} FROM privacy_vault_records
     WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`,
    params,
  );
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

/**
 * Decrypted values for every scan-eligible record — the ONLY bulk-decrypt path,
 * used solely to build broker-scan search vectors (privacyScan.js) inside a
 * USER-TRIGGERED scan pass. Excludes sensitive types by construction:
 * `use_for_scans` is hard-false for ssn/passport/drivers_license/financial_account
 * (enforced on write + re-enforced here via the WHERE clause), so a plaintext
 * SSN can never reach a broker form. Includes `previous` addresses (a broker may
 * still list an old address). Plaintext is returned to the caller but never
 * logged — the count is.
 */
export async function listScanEligibleValues({ subjectId } = {}) {
  const resolvedSubjectId = resolveSubjectId(subjectId);
  const { rows } = await query(
    `SELECT id, type, value_enc, status,
       to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
       to_char(valid_to, 'YYYY-MM-DD') AS valid_to
     FROM privacy_vault_records
     WHERE use_for_scans = TRUE AND subject_id = $1
     ORDER BY type, created_at`,
    [resolvedSubjectId],
  );
  const values = rows.map((row) => ({
    id: row.id,
    type: row.type,
    value: decryptValue(row.value_enc),
    status: row.status,
    validFrom: row.valid_from ?? null,
    validTo: row.valid_to ?? null,
  }));
  console.log(`🔎 Assembled ${values.length} scan-eligible vault values (subject=${resolvedSubjectId})`);
  return values;
}

/** Doctor-style readout: { keyConfigured, recordCounts: { <type>: n } }. */
export async function getVaultStatus({ subjectId } = {}) {
  const resolvedSubjectId = resolveSubjectId(subjectId);
  const { rows } = await query(
    `SELECT type, COUNT(*)::int AS n FROM privacy_vault_records
     WHERE subject_id = $1 GROUP BY type ORDER BY type`,
    [resolvedSubjectId],
  );
  const recordCounts = {};
  for (const row of rows) recordCounts[row.type] = row.n;
  return { keyConfigured: isVaultKeyConfigured(), subjectId: resolvedSubjectId, recordCounts };
}
