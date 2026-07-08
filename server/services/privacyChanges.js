/**
 * Change-of-address inventory workflow (issue #2143, epic #2138).
 *
 * db-primary Postgres per docs/STORAGE.md: one row per declared change in
 * `privacy_change_events`. The workflow is: the user declares "field X changed
 * from A to B" — the OLD vault record is marked `previous` (+ `valid_to`), a
 * replacement record is created/linked, and EVERY `current` holding of the old
 * record flips to `update_pending`. The Changes tab then works that per-org
 * checklist to done (zero `update_pending`).
 *
 * Machine-local: NO federation, NO tombstones (same deferred scope as the
 * vault, #2148). Plaintext PII is NEVER stored here and NEVER logged — the
 * inventory joins masked vault values only. The ONE place plaintext surfaces is
 * `draftUpdateEmail`, which decrypts the NEW value into an email draft the user
 * explicitly requested and must still approve before it sends (never auto-send
 * in this phase).
 *
 * The declare path runs as ONE transaction (atomic): a partial failure must not
 * leave the old record `previous` with holdings un-flipped, or an orphaned
 * replacement record. It uses the transaction client for every write rather
 * than the pool-level `privacyOrgs.setHoldingsStatus`, so the flip both sees the
 * FOR UPDATE lock and rolls back with the rest on error.
 */

import { randomUUID } from 'crypto';
import { query, withTransaction } from '../lib/db.js';
import { ServerError } from '../lib/errorHandler.js';
import { encryptValue, maskValue, ensureVaultKey } from '../lib/vaultCrypto.js';
import { resolveUseForScans, getVaultRecord, revealValue } from './privacyVault.js';
import { getOrg } from './privacyOrgs.js';
import { listAccounts } from './messageAccounts.js';
import { createDraft } from './messageDrafts.js';

const EVENT_COLUMNS = `id, vault_record_id, replacement_record_id, kind, declared_at, note`;

// Holdings statuses that make up the per-event inventory (a `current` holding is
// only relevant to a NEW record, not the change checklist).
const INVENTORY_STATUSES = ['update_pending', 'updated', 'removed'];

// Human-facing field label per change kind — used in the update-email template.
const KIND_FIELD_LABEL = Object.freeze({
  address_change: 'mailing address',
  phone_change: 'phone number',
  email_change: 'email address',
  name_change: 'legal name',
  other: 'information on file',
});

// Default change kind derived from the OLD record's vault type when the caller
// omits `kind` (the UI derives it from the selected record, but the API stays
// forgiving). Anything without a dedicated kind is a generic `other`.
const TYPE_TO_KIND = Object.freeze({
  address: 'address_change',
  phone: 'phone_change',
  email: 'email_change',
  legal_name: 'name_change',
});

export function kindForType(type) {
  return TYPE_TO_KIND[type] ?? 'other';
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    vaultRecordId: row.vault_record_id,
    replacementRecordId: row.replacement_record_id,
    kind: row.kind,
    declaredAt: row.declared_at,
    note: row.note,
  };
}

/** Pure: assemble the update-email body from old→new (masked old, plain new). */
export function renderUpdateEmailBody({ orgName, fieldLabel, oldMasked, newValue }) {
  const lines = [
    `Hello${orgName ? ` ${orgName}` : ''},`,
    '',
    `I am writing to update my ${fieldLabel} on file with your organization.`,
    '',
    `New ${fieldLabel}: ${newValue}`,
  ];
  if (oldMasked) lines.push(`Previous ${fieldLabel} on record: ${oldMasked}`);
  lines.push(
    '',
    'Please update your records accordingly and confirm once the change has been applied.',
    '',
    'Thank you.',
  );
  return lines.join('\n');
}

/**
 * Declare a change: mark the old record `previous`, create/link the replacement,
 * flip every `current` holding of the old record to `update_pending` (recording
 * a forward-looking `current` holding on the new record for each flipped org so
 * "org has old value" and "org needs new value" are both queryable), and write
 * the event row. All in ONE transaction.
 */
export async function declareChange({ vaultRecordId, replacement, replacementRecordId, kind, note }) {
  // ensureVaultKey may append to .env — do it before opening the transaction
  // so the transaction body is pure DB work (a replacement is encrypted inside).
  if (replacement) await ensureVaultKey();
  return withTransaction(async (client) => {
    const { rows: oldRows } = await client.query(
      `SELECT id, type FROM privacy_vault_records WHERE id = $1 FOR UPDATE`, [vaultRecordId],
    );
    const oldRecord = oldRows[0];
    if (!oldRecord) throw new ServerError('Vault record not found', { status: 404, code: 'NOT_FOUND' });

    // Resolve the replacement record id (inline-create, link-existing, or none).
    let replacementId = null;
    if (replacementRecordId) {
      const { rows } = await client.query(
        `SELECT id FROM privacy_vault_records WHERE id = $1`, [replacementRecordId],
      );
      if (!rows[0]) {
        throw new ServerError('Replacement vault record not found', { status: 400, code: 'REPLACEMENT_NOT_FOUND' });
      }
      replacementId = replacementRecordId;
    } else if (replacement) {
      replacementId = randomUUID();
      const type = replacement.type ?? oldRecord.type;
      const useForScans = resolveUseForScans(type, replacement.useForScans);
      await client.query(
        `INSERT INTO privacy_vault_records
           (id, type, label, value_enc, masked_value, status, valid_from, valid_to,
            share_with_twin, use_for_scans, notes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'current', $6, NULL, $7, $8, $9, NOW(), NOW())`,
        [
          replacementId, type, replacement.label,
          encryptValue(replacement.value), maskValue(type, replacement.value),
          replacement.validFrom ?? null,
          replacement.shareWithTwin === true, useForScans, replacement.notes ?? '',
        ],
      );
    }

    // Retire the old record. COALESCE keeps an already-set valid_to intact.
    await client.query(
      `UPDATE privacy_vault_records
       SET status = 'previous', valid_to = COALESCE(valid_to, CURRENT_DATE), updated_at = NOW()
       WHERE id = $1`,
      [vaultRecordId],
    );

    // Flip every current holding of the old record → update_pending, capturing
    // the affected orgs so we can mirror a forward-looking holding on the new one.
    const { rows: flipped } = await client.query(
      `UPDATE privacy_org_holdings SET status = 'update_pending', updated_at = NOW()
       WHERE vault_record_id = $1 AND status = 'current'
       RETURNING org_id`,
      [vaultRecordId],
    );
    if (replacementId) {
      for (const row of flipped) {
        await client.query(
          `INSERT INTO privacy_org_holdings (org_id, vault_record_id, status, noted_at, updated_at)
           VALUES ($1, $2, 'current', NOW(), NOW())
           ON CONFLICT (org_id, vault_record_id) DO UPDATE SET status = 'current', updated_at = NOW()`,
          [row.org_id, replacementId],
        );
      }
    }

    const eventId = randomUUID();
    const resolvedKind = kind ?? kindForType(oldRecord.type);
    const { rows: evRows } = await client.query(
      `INSERT INTO privacy_change_events (id, vault_record_id, replacement_record_id, kind, declared_at, note)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       RETURNING ${EVENT_COLUMNS}`,
      [eventId, vaultRecordId, replacementId, resolvedKind, note ?? ''],
    );
    console.log(`📮 Declared privacy change ${eventId} (kind=${resolvedKind}, orgs flipped=${flipped.length}, replacement=${replacementId ? 'yes' : 'none'})`);
    return rowToEvent(evRows[0]);
  });
}

/** List all change events, newest first, with per-event progress counts + masked old/new values. */
export async function listChangeEvents() {
  const { rows } = await query(
    `SELECT e.id, e.vault_record_id, e.replacement_record_id, e.kind, e.declared_at, e.note,
            ov.type AS old_type, ov.label AS old_label, ov.masked_value AS old_masked,
            rv.type AS new_type, rv.label AS new_label, rv.masked_value AS new_masked,
            COUNT(h.org_id) FILTER (WHERE h.status = 'update_pending')::int AS pending_count,
            COUNT(h.org_id) FILTER (WHERE h.status = 'updated')::int AS updated_count,
            COUNT(h.org_id) FILTER (WHERE h.status = 'removed')::int AS removed_count
     FROM privacy_change_events e
     JOIN privacy_vault_records ov ON ov.id = e.vault_record_id
     LEFT JOIN privacy_vault_records rv ON rv.id = e.replacement_record_id
     LEFT JOIN privacy_org_holdings h
       ON h.vault_record_id = e.vault_record_id AND h.status = ANY($1::text[])
     GROUP BY e.id, ov.type, ov.label, ov.masked_value, rv.type, rv.label, rv.masked_value
     ORDER BY e.declared_at DESC`,
    [INVENTORY_STATUSES],
  );
  return rows.map((row) => ({
    ...rowToEvent(row),
    oldRecord: { type: row.old_type, label: row.old_label, maskedValue: row.old_masked },
    replacementRecord: row.replacement_record_id
      ? { type: row.new_type, label: row.new_label, maskedValue: row.new_masked }
      : null,
    progress: {
      pending: row.pending_count,
      updated: row.updated_count,
      removed: row.removed_count,
      total: row.pending_count + row.updated_count + row.removed_count,
    },
  }));
}

export async function getChangeEvent(eventId) {
  const { rows } = await query(`SELECT ${EVENT_COLUMNS} FROM privacy_change_events WHERE id = $1`, [eventId]);
  return rowToEvent(rows[0]);
}

async function requireEvent(eventId) {
  const event = await getChangeEvent(eventId);
  if (!event) throw new ServerError('Change event not found', { status: 404, code: 'NOT_FOUND' });
  return event;
}

/**
 * Per-org inventory for a change event, grouped by holding status of the OLD
 * record: `{ pending[], updated[], removed[] }`. Each entry carries the org's
 * name, website, and contact email (for the per-org actions + draft-email).
 */
export async function getChangeProgress(eventId) {
  const event = await requireEvent(eventId);
  const { rows } = await query(
    `SELECT h.org_id, h.status, o.name AS org_name, o.website, o.contact
     FROM privacy_org_holdings h
     JOIN privacy_orgs o ON o.id = h.org_id
     WHERE h.vault_record_id = $1 AND h.status = ANY($2::text[])
     ORDER BY o.name`,
    [event.vaultRecordId, INVENTORY_STATUSES],
  );
  const groups = { pending: [], updated: [], removed: [] };
  for (const r of rows) {
    const entry = {
      orgId: r.org_id,
      orgName: r.org_name,
      website: r.website || null,
      contactEmail: r.contact?.email || null,
    };
    if (r.status === 'update_pending') groups.pending.push(entry);
    else if (r.status === 'updated') groups.updated.push(entry);
    else if (r.status === 'removed') groups.removed.push(entry);
  }
  return groups;
}

/** Event + inventory in one payload — powers GET /changes/:id (event detail). */
export async function getChange(eventId) {
  const event = await requireEvent(eventId);
  const [oldRecord, replacementRecord] = await Promise.all([
    getVaultRecord(event.vaultRecordId),
    event.replacementRecordId ? getVaultRecord(event.replacementRecordId) : Promise.resolve(null),
  ]);
  const progress = await getChangeProgress(eventId);
  return { event, oldRecord, replacementRecord, progress };
}

// Flip ONE org's old-record holding to a terminal inventory status. Idempotent:
// a holding already in an inventory status re-settles to the requested one, so a
// double-click is a no-op rather than a 404.
async function setOrgHoldingStatus(event, orgId, toStatus) {
  const { rows } = await query(
    `UPDATE privacy_org_holdings SET status = $1, updated_at = NOW()
     WHERE vault_record_id = $2 AND org_id = $3 AND status = ANY($4::text[])
     RETURNING org_id`,
    [toStatus, event.vaultRecordId, orgId, INVENTORY_STATUSES],
  );
  if (!rows[0]) {
    throw new ServerError('Organization is not part of this change', { status: 404, code: 'HOLDING_NOT_FOUND' });
  }
}

export async function markOrgUpdated(eventId, orgId) {
  const event = await requireEvent(eventId);
  await setOrgHoldingStatus(event, orgId, 'updated');
  console.log(`✅ Change ${eventId}: org ${orgId} marked updated`);
  return getChangeProgress(eventId);
}

export async function markOrgRemoved(eventId, orgId) {
  const event = await requireEvent(eventId);
  await withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE privacy_org_holdings SET status = 'removed', updated_at = NOW()
       WHERE vault_record_id = $1 AND org_id = $2 AND status = ANY($3::text[])
       RETURNING org_id`,
      [event.vaultRecordId, orgId, INVENTORY_STATUSES],
    );
    if (!rows[0]) {
      throw new ServerError('Organization is not part of this change', { status: 404, code: 'HOLDING_NOT_FOUND' });
    }
    // The org dropped the field entirely — retire the forward-looking holding we
    // created on the replacement record at declare time so the Organizations tab
    // stays honest (this org does not hold the new value either).
    if (event.replacementRecordId) {
      await client.query(
        `DELETE FROM privacy_org_holdings WHERE vault_record_id = $1 AND org_id = $2`,
        [event.replacementRecordId, orgId],
      );
    }
  });
  console.log(`🚫 Change ${eventId}: org ${orgId} marked removed`);
  return getChangeProgress(eventId);
}

/**
 * Draft a plain "please update my records" email for one org in the inventory,
 * old→new, into the messages drafts queue as an UNAPPROVED draft (status
 * `draft`). Template-only (no LLM), runs only on an explicit user click. The
 * new value is decrypted for the body (the org needs the actual new address);
 * the draft still requires user approval before it can send.
 */
export async function draftUpdateEmail(eventId, orgId) {
  const event = await requireEvent(eventId);
  if (!event.replacementRecordId) {
    throw new ServerError('No replacement record to update to', { status: 400, code: 'REPLACEMENT_REQUIRED' });
  }
  const org = await getOrg(orgId);
  if (!org) throw new ServerError('Organization not found', { status: 404, code: 'NOT_FOUND' });
  const to = org.contact?.email;
  if (!to) throw new ServerError('Organization has no contact email', { status: 400, code: 'ORG_EMAIL_MISSING' });

  const accounts = await listAccounts();
  const account = accounts.find((a) => a.type === 'gmail') ?? accounts[0];
  if (!account) throw new ServerError('No message account configured', { status: 400, code: 'NO_MESSAGE_ACCOUNT' });

  const oldRecord = await getVaultRecord(event.vaultRecordId);
  const newReveal = await revealValue(event.replacementRecordId);
  const fieldLabel = KIND_FIELD_LABEL[event.kind] ?? KIND_FIELD_LABEL.other;
  const subject = `Request to update my ${fieldLabel}`;
  const body = renderUpdateEmailBody({
    orgName: org.name,
    fieldLabel,
    oldMasked: oldRecord?.maskedValue,
    newValue: newReveal.value,
  });

  const draft = await createDraft({
    accountId: account.id,
    to: [to],
    subject,
    body,
    generatedBy: 'privacy-change',
    sendVia: account.type === 'gmail' ? 'api' : 'playwright',
  });
  console.log(`📧 Drafted privacy update email for org ${orgId} (change ${eventId}, draft ${draft.id})`);
  return { draftId: draft.id, status: draft.status };
}
