/**
 * Postgres-backed round-trip for the change-of-address inventory workflow
 * (issue #2143). Like privacyOrgs.db.test.js, this needs a live PostgreSQL with
 * the schema applied; if none is reachable it SKIPS cleanly. Exercises the
 * declare transaction (old record retired, holdings flipped, forward holdings
 * mirrored, event written), progress grouping + math, idempotent per-org marks,
 * removal dropping the replacement holding, and draft-email creating an
 * unapproved draft. The messages subsystem is mocked so no file writes touch
 * real data/. Runs via `npm run test:db` (→ portos_test) ONLY.
 */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

vi.mock('./messageAccounts.js', () => ({
  listAccounts: vi.fn(async () => [{ id: 'acct-test', type: 'gmail', name: 'Test', canSend: true }]),
}));
vi.mock('./messageDrafts.js', () => ({
  createDraft: vi.fn(async (data) => ({ id: 'draft-test', status: 'draft', ...data })),
}));

const HEX_KEY = 'e'.repeat(64);
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
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'privacy_change_events') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'privacy_change_events table not present';
  }
}

const runDb = requireDbOrSkip('services/privacyChanges.db.test', dbReady, skipReason);

describe.skipIf(!runDb)('privacy changes DB round-trip', () => {
  let changes;
  let orgs;
  let vault;
  const createdOrgs = [];
  const createdVaultRecords = [];
  const createdEvents = [];

  beforeAll(async () => {
    // Set only while the suite runs, before any service import, so a skipped suite never leaks it.
    process.env.PRIVACY_VAULT_KEY = HEX_KEY;
    changes = await import('./privacyChanges.js');
    orgs = await import('./privacyOrgs.js');
    vault = await import('./privacyVault.js');
  });

  afterAll(async () => {
    try {
      for (const id of createdEvents) await query(`DELETE FROM privacy_change_events WHERE id = $1`, [id]).catch(() => {});
      for (const id of createdOrgs) await query(`DELETE FROM privacy_orgs WHERE id = $1`, [id]).catch(() => {});
      for (const id of createdVaultRecords) await query(`DELETE FROM privacy_vault_records WHERE id = $1`, [id]).catch(() => {});
      await close();
    } finally {
      if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
      else process.env.PRIVACY_VAULT_KEY = originalKey;
    }
  });

  it('declares a change: retires the old record, flips holdings, mirrors forward holdings, writes the event', async () => {
    const oldRec = await vault.createVaultRecord({ type: 'address', label: 'Old home', value: '1 Old Rd' });
    createdVaultRecords.push(oldRec.id);
    const orgA = await orgs.createOrg({ name: 'Bank A' });
    const orgB = await orgs.createOrg({ name: 'Bank B', contact: { email: 'ops@bankb.example' } });
    createdOrgs.push(orgA.id, orgB.id);
    await orgs.setOrgHoldings(orgA.id, [{ vaultRecordId: oldRec.id, status: 'current' }]);
    await orgs.setOrgHoldings(orgB.id, [{ vaultRecordId: oldRec.id, status: 'current' }]);

    const event = await changes.declareChange({
      vaultRecordId: oldRec.id,
      replacement: { label: 'New home', value: '742 New Ave' },
      note: 'moved cross-town',
    });
    createdEvents.push(event.id);
    createdVaultRecords.push(event.replacementRecordId);

    expect(event.kind).toBe('address_change');
    expect(event.replacementRecordId).toBeTruthy();

    // Old record marked previous with a valid_to stamp; new record is current.
    const oldAfter = await vault.getVaultRecord(oldRec.id);
    expect(oldAfter.status).toBe('previous');
    expect(oldAfter.validTo).toBeTruthy();
    const newRec = await vault.getVaultRecord(event.replacementRecordId);
    expect(newRec.status).toBe('current');
    expect(newRec.type).toBe('address'); // inherited from the old record
    expect(newRec.maskedValue).not.toContain('742 New Ave'); // masked, never plaintext

    // Both orgs flipped to update_pending on the old record.
    const progress = await changes.getChangeProgress(event.id);
    expect(progress.pending).toHaveLength(2);
    expect(progress.updated).toHaveLength(0);

    // Forward-looking current holdings exist on the NEW record for both orgs.
    const holdersOfNew = await orgs.getOrgsHoldingRecord(event.replacementRecordId);
    expect(holdersOfNew).toHaveLength(2);
    expect(holdersOfNew.every((h) => h.status === 'current')).toBe(true);
  });

  it('drives progress to done via mark updated / removed, idempotently', async () => {
    const oldRec = await vault.createVaultRecord({ type: 'phone', label: 'Cell', value: '+1 555 0100' });
    createdVaultRecords.push(oldRec.id);
    const orgA = await orgs.createOrg({ name: 'Carrier A' });
    const orgB = await orgs.createOrg({ name: 'Carrier B' });
    createdOrgs.push(orgA.id, orgB.id);
    await orgs.setOrgHoldings(orgA.id, [{ vaultRecordId: oldRec.id, status: 'current' }]);
    await orgs.setOrgHoldings(orgB.id, [{ vaultRecordId: oldRec.id, status: 'current' }]);

    const event = await changes.declareChange({
      vaultRecordId: oldRec.id,
      replacement: { label: 'New cell', value: '+1 555 0200' },
    });
    createdEvents.push(event.id);
    createdVaultRecords.push(event.replacementRecordId);

    await changes.markOrgUpdated(event.id, orgA.id);
    // Idempotent: a second mark on the same org is a no-op, not a 404.
    const p1 = await changes.markOrgUpdated(event.id, orgA.id);
    expect(p1.updated).toHaveLength(1);
    expect(p1.pending).toHaveLength(1);

    const p2 = await changes.markOrgRemoved(event.id, orgB.id);
    expect(p2.pending).toHaveLength(0); // done — zero pending
    expect(p2.updated).toHaveLength(1);
    expect(p2.removed).toHaveLength(1);

    // Removal dropped orgB's forward holding on the new record; orgA's remains.
    const holdersOfNew = await orgs.getOrgsHoldingRecord(event.replacementRecordId);
    expect(holdersOfNew.map((h) => h.orgId)).toEqual([orgA.id]);
  });

  it('lists events with progress counts and masked values (never plaintext)', async () => {
    const list = await changes.listChangeEvents();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(list)).not.toContain('742 New Ave');
    expect(list[0].progress).toHaveProperty('total');
  });

  it('refuses an unsupported account then drafts an unapproved update email to the org contact', async () => {
    const oldRec = await vault.createVaultRecord({ type: 'email', label: 'Old email', value: 'old@me.example' });
    createdVaultRecords.push(oldRec.id);
    const org = await orgs.createOrg({ name: 'Subscription Co', contact: { email: 'support@sub.example' } });
    createdOrgs.push(org.id);
    await orgs.setOrgHoldings(org.id, [{ vaultRecordId: oldRec.id, status: 'current' }]);

    const event = await changes.declareChange({
      vaultRecordId: oldRec.id,
      replacement: { label: 'New email', value: 'new@me.example' },
    });
    createdEvents.push(event.id);
    createdVaultRecords.push(event.replacementRecordId);

    const { listAccounts } = await import('./messageAccounts.js');
    const { createDraft } = await import('./messageDrafts.js');
    const draftsBefore = createDraft.mock.calls.length;
    listAccounts.mockResolvedValueOnce([{ id: 'outlook-test', type: 'outlook', canSend: false }]);
    await expect(changes.draftUpdateEmail(event.id, org.id)).rejects.toMatchObject({ code: 'NO_MESSAGE_ACCOUNT' });
    expect(createDraft).toHaveBeenCalledTimes(draftsBefore);
    expect((await changes.getChangeProgress(event.id)).pending.map(item => item.orgId)).toEqual([org.id]);

    const result = await changes.draftUpdateEmail(event.id, org.id);
    expect(result.status).toBe('draft'); // unapproved
    const draftArg = createDraft.mock.calls.at(-1)[0];
    expect(draftArg.to).toEqual(['support@sub.example']);
    expect(draftArg.body).toContain('new@me.example'); // new value plaintext for the org
    expect(draftArg.generatedBy).toBe('privacy-change');
  });

  it('refuses sensitive replacement types and non-holding orgs without drafting', async () => {
    const oldRec = await vault.createVaultRecord({ type: 'ssn', label: 'Old SSN', value: '111-22-3333' });
    createdVaultRecords.push(oldRec.id);
    const holder = await orgs.createOrg({ name: 'Holder Co', contact: { email: 'h@holder.example' } });
    const stranger = await orgs.createOrg({ name: 'Stranger Co', contact: { email: 's@stranger.example' } });
    createdOrgs.push(holder.id, stranger.id);
    await orgs.setOrgHoldings(holder.id, [{ vaultRecordId: oldRec.id, status: 'current' }]);
    const event = await changes.declareChange({
      vaultRecordId: oldRec.id,
      replacement: { label: 'New SSN', value: '444-55-6666' },
    });
    createdEvents.push(event.id);
    createdVaultRecords.push(event.replacementRecordId);

    const { createDraft } = await import('./messageDrafts.js');
    const before = createDraft.mock.calls.length;
    await expect(changes.draftUpdateEmail(event.id, stranger.id)).rejects.toMatchObject({ status: 404, code: 'HOLDING_NOT_FOUND' });
    await expect(changes.draftUpdateEmail(event.id, holder.id)).rejects.toMatchObject({ status: 400, code: 'SENSITIVE_TYPE_EMAIL_FORBIDDEN' });
    expect(createDraft).toHaveBeenCalledTimes(before);
  });
});
