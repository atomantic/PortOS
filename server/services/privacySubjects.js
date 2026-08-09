/**
 * Household subjects + the consent gate (issue #3658, epic #2138).
 *
 * db-primary Postgres per docs/STORAGE.md: one row per person the Privacy
 * Center works on behalf of in `privacy_subjects`, with the consent audit trail
 * in `privacy_consents`. Every other privacy table carries a `subject_id` FK
 * defaulted to the seeded `self` row, so an install that never adds a second
 * subject behaves exactly as it did before this module existed.
 *
 * Machine-local: NO federation, NO tombstones — NEVER federated, by decision
 * rather than deferral (ADR
 * docs/decisions/2026-08-08-privacy-records-machine-local.md, #2148). Deleting a
 * subject is a hard DELETE that CASCADES their vault records, orgs, holdings,
 * change events, broker cases, and consent rows.
 *
 * CONSENT IS ENGINE-ENFORCED, NOT UI-ENFORCED. Carried verbatim from unbroker's
 * no-consent-no-action rule: `assertSubjectConsent()` is called by
 * `privacyScan.runScanPass()` and `privacyOptOut.runOptOutPass()` /
 * `runVerificationPass()` before either touches a broker. Hiding the button in
 * the UI is NOT sufficient — a scheduled recheck, a direct API call, or a future
 * agent path all route through the service, which is where the refusal lives.
 *
 * Log lines never carry a subject's `display_name` — a household member's name
 * is PII in exactly the way the vault's values are (see privacyVault.js's
 * plaintext-never-logged posture); logs carry id + relationship only.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { PRIVACY_SELF_SUBJECT_ID } from '../lib/privacyValidation.js';

const SUBJECT_COLUMNS = `id, display_name, relationship, created_at, updated_at`;

function rowToSubject(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name,
    relationship: row.relationship,
    isSelf: String(row.id).toLowerCase() === PRIVACY_SELF_SUBJECT_ID,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Present only on the aggregate list query.
    ...(row.consent_count !== undefined ? { consentCount: row.consent_count } : {}),
    ...(row.record_count !== undefined ? { recordCount: row.record_count } : {}),
  };
}

/**
 * Normalize an optional caller-supplied subject id to a concrete one. Absent /
 * empty ⇒ the seeded `self` row, which is what every pre-#3658 caller means.
 * Pure — no DB round-trip (existence is enforced by the FK / assertSubject).
 */
export function resolveSubjectId(subjectId) {
  // Lower-cased: Zod's uuid() accepts an upper-case uuid, and the seeded row's
  // id is stored lower-case — comparing the two raw would make an upper-case
  // `self` id look like a different subject (and defeat the delete guard).
  return subjectId ? String(subjectId).toLowerCase() : PRIVACY_SELF_SUBJECT_ID;
}

/**
 * Write a consent row for a subject. Append-only audit trail. Asserts the
 * subject first so an unknown id is a clean 404 rather than a raw FK violation,
 * and defaults `scope` (the column is NOT NULL and the API leaves it optional).
 */
export async function recordConsent({ subjectId, scope, method, note }) {
  const resolved = (await assertSubject(subjectId)).id;
  const id = randomUUID();
  // The legacy free-text `subject` column keeps its DEFAULT 'self' — it is
  // frozen historical audit data; `subject_id` is the live scope (#3658).
  await query(
    `INSERT INTO privacy_consents (id, subject_id, scope, method, note, granted_at)
     VALUES ($1, $2, $3, $4, $5, NOW())`,
    [id, resolved, scope ?? 'pii_vault', method, note ?? ''],
  );
  console.log(`📝 Recorded privacy consent ${id} (subject=${resolved}, scope=${scope ?? 'pii_vault'}, method=${method})`);
  return { id, subjectId: resolved, scope: scope ?? 'pii_vault', method, note: note ?? '' };
}

// ─── Subject CRUD ───────────────────────────────────────────────────────────

/**
 * List every subject with their consent-row count and vault-record count, so
 * the UI switcher can badge a subject that has no consent on file (and would
 * therefore be refused by the engine).
 */
export async function listSubjects() {
  const { rows } = await query(
    `SELECT s.id, s.display_name, s.relationship, s.created_at, s.updated_at,
            (SELECT COUNT(*)::int FROM privacy_consents c WHERE c.subject_id = s.id) AS consent_count,
            (SELECT COUNT(*)::int FROM privacy_vault_records v WHERE v.subject_id = s.id) AS record_count
     FROM privacy_subjects s
     ORDER BY (s.id <> $1), s.display_name ASC`,
    [PRIVACY_SELF_SUBJECT_ID],
  );
  return rows.map(rowToSubject);
}

export async function getSubject(id) {
  const { rows } = await query(`SELECT ${SUBJECT_COLUMNS} FROM privacy_subjects WHERE id = $1`, [id]);
  return rowToSubject(rows[0]);
}

/**
 * Assert the subject exists, returning its row. Every subject-scoped write path
 * calls this so a stale/bogus id surfaces as a clean 404 rather than a raw
 * Postgres FK violation (23503) at INSERT time.
 */
export async function assertSubject(subjectId) {
  const resolved = resolveSubjectId(subjectId);
  const subject = await getSubject(resolved);
  if (!subject) {
    throw new ServerError(`Privacy subject ${resolved} not found`, { status: 404, code: 'SUBJECT_NOT_FOUND' });
  }
  return subject;
}

/**
 * Add a household member. The consent method is REQUIRED and its row is written
 * in the SAME transaction as the subject — there is no window in which a subject
 * exists without recorded consent, so the engine guard can never be raced.
 */
export async function createSubject({ displayName, relationship, consentMethod, consentNote }) {
  const id = randomUUID();
  const resolvedRelationship = relationship ?? 'other';
  const subject = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO privacy_subjects (id, display_name, relationship, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())
       RETURNING ${SUBJECT_COLUMNS}`,
      [id, displayName, resolvedRelationship],
    );
    await client.query(
      `INSERT INTO privacy_consents (id, subject_id, scope, method, note, granted_at)
       VALUES ($1, $2, 'pii_vault', $3, $4, NOW())`,
      [randomUUID(), id, consentMethod, consentNote ?? ''],
    );
    return rowToSubject(rows[0]);
  });
  // display_name is PII — log the id + relationship only (privacyVault.js posture).
  console.log(`👤 Created privacy subject ${id} (relationship=${resolvedRelationship}, consent=${consentMethod})`);
  return subject;
}

export async function updateSubject(id, patch) {
  const sets = [];
  const params = [];
  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.displayName !== undefined) add('display_name', patch.displayName);
  if (patch.relationship !== undefined) add('relationship', patch.relationship);
  if (sets.length === 0) return assertSubject(id);
  params.push(id);
  const { rows } = await query(
    `UPDATE privacy_subjects SET ${[...sets, 'updated_at = NOW()'].join(', ')}
     WHERE id = $${params.length} RETURNING ${SUBJECT_COLUMNS}`,
    params,
  );
  if (!rows[0]) throw new ServerError('Privacy subject not found', { status: 404, code: 'SUBJECT_NOT_FOUND' });
  console.log(`👤 Updated privacy subject ${id}`);
  return rowToSubject(rows[0]);
}

/**
 * Hard-delete a subject and, by FK CASCADE, every record scoped to them (vault
 * records, orgs, holdings, change events, broker cases, consents). Machine-local
 * means no tombstone — the ADR's hard-delete rule applies unchanged.
 *
 * `self` can never be deleted: it is the default every subject-scoped column
 * falls back to, so removing it would break every subsequent insert.
 */
export async function deleteSubject(id) {
  if (resolveSubjectId(id) === PRIVACY_SELF_SUBJECT_ID) {
    throw new ServerError(
      'The `self` subject cannot be deleted',
      { status: 400, code: 'SELF_SUBJECT_UNDELETABLE' },
    );
  }
  const { rows } = await query(`DELETE FROM privacy_subjects WHERE id = $1 RETURNING id`, [id]);
  if (!rows[0]) throw new ServerError('Privacy subject not found', { status: 404, code: 'SUBJECT_NOT_FOUND' });
  console.log(`🗑️ Deleted privacy subject ${id} (vault/orgs/holdings/changes/cases cascaded)`);
  return { ok: true };
}

// ─── Consent gate (engine-enforced) ─────────────────────────────────────────

/** The consent audit trail for one subject, newest first. */
export async function listSubjectConsents(subjectId) {
  const resolved = resolveSubjectId(subjectId);
  const { rows } = await query(
    `SELECT id, subject_id, scope, method, note, granted_at
     FROM privacy_consents WHERE subject_id = $1 ORDER BY granted_at DESC`,
    [resolved],
  );
  return rows.map((row) => ({
    id: row.id,
    subjectId: row.subject_id,
    scope: row.scope,
    method: row.method,
    note: row.note ?? '',
    grantedAt: row.granted_at,
  }));
}

/**
 * Does this subject have active consent on file? ANY consent row counts — there
 * is no revocation column, because revoking consent means deleting the subject
 * (which hard-deletes their records; see deleteSubject). Callers that need a
 * hard stop use assertSubjectConsent instead.
 */
export async function hasActiveConsent(subjectId) {
  const resolved = resolveSubjectId(subjectId);
  const { rows } = await query(
    `SELECT 1 FROM privacy_consents WHERE subject_id = $1 LIMIT 1`, [resolved],
  );
  return rows.length > 0;
}

/**
 * THE consent guard. `privacyScan` and `privacyOptOut` call this before any
 * broker work — a subject with no consent row on file gets a hard refusal, at
 * the SERVICE layer, so a scheduled recheck / direct API call / future agent
 * path is refused exactly like a UI click would be. Mirrors the existing
 * disclosure-allowlist guard in privacyOptOut.js: the engine's guarantees do not
 * live in the UI.
 *
 * Returns the subject row so callers can log/annotate without a second read.
 */
export async function assertSubjectConsent(subjectId, { action = 'this action' } = {}) {
  const subject = await assertSubject(subjectId);
  if (await hasActiveConsent(subject.id)) return subject;
  console.log(`⛔ Refused ${action} for privacy subject ${subject.id}: no consent on file`);
  throw new ServerError(
    `Privacy subject ${subject.id} has no recorded consent — ${action} refused`,
    { status: 403, code: 'SUBJECT_CONSENT_REQUIRED' },
  );
}
