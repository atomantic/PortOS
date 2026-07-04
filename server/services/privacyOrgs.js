/**
 * Trusted Organizations registry (issue #2141, epic #2138).
 *
 * db-primary Postgres per docs/STORAGE.md: `privacy_orgs` (one row per
 * organization that has or had the user's PII) and `privacy_org_holdings`
 * (which vault records each org holds, with a per-holding status). Machine-
 * local: NO federation, NO tombstones (same deferred scope as the vault,
 * #2148) — deletes are hard DELETEs with cascading holdings cleanup.
 *
 * Holdings responses join masked vault values ONLY — never plaintext. The
 * one decrypt path stays `revealValue()` in privacyVault.js; this service
 * never touches `value_enc`.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';

const ORG_COLUMNS = `id, name, category, website, trust, status, contact,
  social_account_id, notes, created_at, updated_at`;

function rowToOrg(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    website: row.website,
    trust: row.trust,
    status: row.status,
    contact: row.contact ?? {},
    socialAccountId: row.social_account_id,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToHolding(row) {
  return {
    orgId: row.org_id,
    vaultRecordId: row.vault_record_id,
    status: row.status,
    notedAt: row.noted_at,
    updatedAt: row.updated_at,
    // Present only on joined queries that select these columns.
    ...(row.type !== undefined ? { vaultType: row.type } : {}),
    ...(row.label !== undefined ? { vaultLabel: row.label } : {}),
    ...(row.masked_value !== undefined ? { vaultMaskedValue: row.masked_value } : {}),
    ...(row.org_name !== undefined ? { orgName: row.org_name } : {}),
  };
}

export async function createOrg(input) {
  const id = randomUUID();
  const { rows } = await query(
    `INSERT INTO privacy_orgs
       (id, name, category, website, trust, status, contact, social_account_id, notes, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
     RETURNING ${ORG_COLUMNS}`,
    [
      id, input.name,
      input.category ?? 'other', input.website ?? '',
      input.trust ?? 'trusted', input.status ?? 'active',
      JSON.stringify(input.contact ?? {}),
      input.socialAccountId ?? null,
      input.notes ?? '',
    ],
  );
  console.log(`🏢 Created privacy org ${id} (name=${input.name})`);
  return rowToOrg(rows[0]);
}

export async function listOrgs({ trust, status, category } = {}) {
  const clauses = [];
  const params = [];
  if (trust) { params.push(trust); clauses.push(`trust = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  if (category) { params.push(category); clauses.push(`category = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT ${ORG_COLUMNS} FROM privacy_orgs ${where} ORDER BY name ASC`,
    params,
  );
  return rows.map(rowToOrg);
}

export async function getOrg(id) {
  const { rows } = await query(`SELECT ${ORG_COLUMNS} FROM privacy_orgs WHERE id = $1`, [id]);
  return rowToOrg(rows[0]);
}

export async function updateOrg(id, patch) {
  const sets = [];
  const params = [];
  const add = (column, value) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) add('name', patch.name);
  if (patch.category !== undefined) add('category', patch.category);
  if (patch.website !== undefined) add('website', patch.website);
  if (patch.trust !== undefined) add('trust', patch.trust);
  if (patch.status !== undefined) add('status', patch.status);
  if (patch.contact !== undefined) add('contact', JSON.stringify(patch.contact));
  if (patch.socialAccountId !== undefined) add('social_account_id', patch.socialAccountId);
  if (patch.notes !== undefined) add('notes', patch.notes);
  params.push(id);
  const { rows } = await query(
    `UPDATE privacy_orgs SET ${[...sets, 'updated_at = NOW()'].join(', ')}
     WHERE id = $${params.length} RETURNING ${ORG_COLUMNS}`,
    params,
  );
  if (!rows[0]) throw new ServerError('Organization not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🏢 Updated privacy org ${id}`);
  return rowToOrg(rows[0]);
}

export async function deleteOrg(id) {
  const { rows } = await query(`DELETE FROM privacy_orgs WHERE id = $1 RETURNING id`, [id]);
  if (!rows[0]) throw new ServerError('Organization not found', { status: 404, code: 'NOT_FOUND' });
  console.log(`🗑️ Deleted privacy org ${id} (holdings cascaded)`);
  return { ok: true };
}

/**
 * Which vault records does org `orgId` hold — joined with masked vault
 * fields for display. Never selects `value_enc`.
 */
export async function getHoldingsForOrg(orgId) {
  const { rows } = await query(
    `SELECT h.org_id, h.vault_record_id, h.status, h.noted_at, h.updated_at,
            v.type, v.label, v.masked_value
     FROM privacy_org_holdings h
     JOIN privacy_vault_records v ON v.id = h.vault_record_id
     WHERE h.org_id = $1
     ORDER BY v.type, v.label`,
    [orgId],
  );
  return rows.map(rowToHolding);
}

/** Which orgs hold vault record `vaultRecordId` — powers the inventory view. */
export async function getOrgsHoldingRecord(vaultRecordId) {
  const { rows } = await query(
    `SELECT h.org_id, h.vault_record_id, h.status, h.noted_at, h.updated_at,
            o.name AS org_name
     FROM privacy_org_holdings h
     JOIN privacy_orgs o ON o.id = h.org_id
     WHERE h.vault_record_id = $1
     ORDER BY o.name`,
    [vaultRecordId],
  );
  return rows.map(rowToHolding);
}

/**
 * Replace-set the holdings for an org: the body's list of
 * `{ vaultRecordId, status }` becomes the full holdings set for the org —
 * anything not listed is removed. Runs as one statement per side (delete the
 * complement, upsert the rest) rather than a delete-all + reinsert, so an
 * unrelated concurrent read never sees a momentarily-empty holdings set.
 * The whole delete+upsert sequence runs inside ONE transaction — without it,
 * a bad `vaultRecordId` partway through the upsert loop (foreign key
 * violation, see below) would leave the DELETE committed but only some of
 * the new rows written: neither the old nor the requested holdings set.
 * `FOR UPDATE` row-locks the org for the duration of the transaction (same
 * pattern as `updateVaultRecord` in privacyVault.js) — without it, two
 * concurrent replace calls for the same org (e.g. a double-click, or two
 * browser tabs saving holdings at once) can both pass the existence check,
 * each delete against the pre-existing set, and each upsert their own rows —
 * leaving the UNION of both requests rather than the last full replacement,
 * silently defeating the documented replace-set semantics.
 */
export async function setOrgHoldings(orgId, holdings) {
  await withTransaction(async (client) => {
    const { rows: orgRows } = await client.query(`SELECT id FROM privacy_orgs WHERE id = $1 FOR UPDATE`, [orgId]);
    if (!orgRows[0]) throw new ServerError('Organization not found', { status: 404, code: 'NOT_FOUND' });

    const ids = holdings.map((h) => h.vaultRecordId);
    if (ids.length === 0) {
      await client.query(`DELETE FROM privacy_org_holdings WHERE org_id = $1`, [orgId]);
    } else {
      await client.query(
        `DELETE FROM privacy_org_holdings WHERE org_id = $1 AND vault_record_id != ALL($2::uuid[])`,
        [orgId, ids],
      );
      for (const h of holdings) {
        // A vaultRecordId that doesn't exist (stale UI id, typo, raced with a
        // deletion) trips the FK constraint — surface it as a clean 400
        // instead of a raw Postgres constraint-violation 500.
        await client.query(
          `INSERT INTO privacy_org_holdings (org_id, vault_record_id, status, noted_at, updated_at)
           VALUES ($1, $2, $3, NOW(), NOW())
           ON CONFLICT (org_id, vault_record_id)
           DO UPDATE SET status = EXCLUDED.status, updated_at = NOW()`,
          [orgId, h.vaultRecordId, h.status ?? 'current'],
        ).catch((err) => {
          if (err?.code === '23503') {
            throw new ServerError(`Vault record ${h.vaultRecordId} not found`, { status: 400, code: 'VAULT_RECORD_NOT_FOUND' });
          }
          throw err;
        });
      }
    }
    console.log(`🔗 Set ${ids.length} holdings for privacy org ${orgId}`);
  });
  return getHoldingsForOrg(orgId);
}

/**
 * Batch status flip across ALL orgs holding a given vault record — used by
 * the Phase 4 change-of-address workflow ("mark every org holding my old
 * address as update_pending"). Only rows currently in `fromStatus` flip.
 */
export async function setHoldingsStatus(vaultRecordId, fromStatus, toStatus) {
  const { rows } = await query(
    `UPDATE privacy_org_holdings SET status = $1, updated_at = NOW()
     WHERE vault_record_id = $2 AND status = $3
     RETURNING org_id, vault_record_id`,
    [toStatus, vaultRecordId, fromStatus],
  );
  console.log(`🔁 Flipped ${rows.length} holdings for vault record ${vaultRecordId} (${fromStatus} → ${toStatus})`);
  return { updated: rows.length };
}

/** Per-org holding counts + per-vault-record org counts — powers the inventory view. */
export async function getHoldingsSummary() {
  const [byOrg, byRecord] = await Promise.all([
    query(
      `SELECT o.id AS org_id, o.name AS org_name, COUNT(h.vault_record_id)::int AS holding_count
       FROM privacy_orgs o
       LEFT JOIN privacy_org_holdings h ON h.org_id = o.id
       GROUP BY o.id, o.name
       ORDER BY o.name`,
    ),
    query(
      `SELECT v.id AS vault_record_id, v.type, v.label, COUNT(h.org_id)::int AS org_count
       FROM privacy_vault_records v
       LEFT JOIN privacy_org_holdings h ON h.vault_record_id = v.id
       GROUP BY v.id, v.type, v.label
       ORDER BY v.type, v.label`,
    ),
  ]);
  return {
    byOrg: byOrg.rows.map((r) => ({ orgId: r.org_id, orgName: r.org_name, holdingCount: r.holding_count })),
    byVaultRecord: byRecord.rows.map((r) => ({
      vaultRecordId: r.vault_record_id, type: r.type, label: r.label, orgCount: r.org_count,
    })),
  };
}
