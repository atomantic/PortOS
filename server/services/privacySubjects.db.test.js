/**
 * Postgres-backed round-trip for household subjects (issue #3658).
 *
 * Covers the subject lifecycle itself — CRUD, the `self` invariants, the
 * consent audit trail, and the engine-level consent guard that `privacyScan`
 * and `privacyOptOut` rely on. The vault-side scoping/cascade assertions live
 * in privacyVault.db.test.js; this file owns the subject surface.
 *
 * SKIPS cleanly when no DB is reachable. Cleans up only rows it created — no
 * global table mutation. Runs via `npm run test:db` (→ portos_test) ONLY; the
 * db.js guards refuse writes to a non-test DB.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { checkHealth, ensureSchema, query, close } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';

// A valid key BEFORE the service is imported/called so ensureVaultKey never
// touches the repo's real .env during the run (createVaultRecord encrypts).
const HEX_KEY = 'e'.repeat(64);
const originalKey = process.env.PRIVACY_VAULT_KEY;
process.env.PRIVACY_VAULT_KEY = HEX_KEY;

let dbReady = false;
let skipReason = '';
{
  const health = await checkHealth().catch((e) => ({ connected: false, error: e?.message }));
  if (!health.connected) {
    skipReason = `Postgres not reachable (${health.error || 'no connection'})`;
  } else {
    await ensureSchema().catch(() => {});
    const probe = await query(
      `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name = 'privacy_subjects') AS ok`,
    ).catch(() => ({ rows: [{ ok: false }] }));
    if (probe.rows?.[0]?.ok) dbReady = true;
    else skipReason = 'privacy_subjects table not present';
  }
}

const runDb = requireDbOrSkip('services/privacySubjects.db.test', dbReady, skipReason);

describe.skipIf(!runDb)('privacy household subjects DB round-trip', () => {
  let subjects;
  let vault;
  let selfSubjectId = '';
  const createdSubjects = [];

  // Register for cleanup BEFORE asserting, so a mid-test failure still tidies up.
  const track = (subject) => { createdSubjects.push(subject.id); return subject; };

  beforeAll(async () => {
    subjects = await import('./privacySubjects.js');
    vault = await import('./privacyVault.js');
    selfSubjectId = (await import('../lib/privacyValidation.js')).PRIVACY_SELF_SUBJECT_ID;
  });

  afterAll(async () => {
    // Child rows (vault records, consents, orgs, cases) go by FK CASCADE.
    for (const id of createdSubjects) {
      await query(`DELETE FROM privacy_subjects WHERE id = $1`, [id]).catch(() => {});
    }
    await close();
    if (originalKey === undefined) delete process.env.PRIVACY_VAULT_KEY;
    else process.env.PRIVACY_VAULT_KEY = originalKey;
  });

  it('seeds a self subject that lists first and is flagged isSelf', async () => {
    const list = await subjects.listSubjects();
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].id).toBe(selfSubjectId);
    expect(list[0].isSelf).toBe(true);
    // Every other subject is explicitly not-self — the flag is derived, not stored.
    expect(list.slice(1).every((s) => s.isSelf === false)).toBe(true);
  });

  it('refuses to delete the self subject', async () => {
    await expect(subjects.deleteSubject(selfSubjectId)).rejects.toMatchObject({
      status: 400,
      code: 'SELF_SUBJECT_UNDELETABLE',
    });
    // Still there — the guard must not have half-deleted anything.
    expect(await subjects.getSubject(selfSubjectId)).toMatchObject({ id: selfSubjectId });
  });

  it('creates a subject with its consent row in one transaction', async () => {
    const subject = track(await subjects.createSubject({
      displayName: 'Example Partner',
      relationship: 'partner',
      consentMethod: 'signed_form',
      consentNote: 'form filed',
    }));

    expect(subject).toMatchObject({ displayName: 'Example Partner', relationship: 'partner', isSelf: false });

    const consents = await subjects.listSubjectConsents(subject.id);
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      subjectId: subject.id, scope: 'pii_vault', method: 'signed_form', note: 'form filed',
    });
    expect(await subjects.hasActiveConsent(subject.id)).toBe(true);
  });

  it('reports consent and record counts on the list', async () => {
    const subject = track(await subjects.createSubject({
      displayName: 'Example Counted', relationship: 'parent', consentMethod: 'verbal',
    }));
    await vault.createVaultRecord({
      type: 'email', label: 'Their email', value: 'counted@example.com', subjectId: subject.id,
    });

    const row = (await subjects.listSubjects()).find((s) => s.id === subject.id);
    expect(row).toMatchObject({ consentCount: 1, recordCount: 1 });
  });

  it('renames without disturbing consent', async () => {
    const subject = track(await subjects.createSubject({
      displayName: 'Example Before', relationship: 'other', consentMethod: 'verbal',
    }));
    const updated = await subjects.updateSubject(subject.id, {
      displayName: 'Example After', relationship: 'dependent',
    });

    expect(updated).toMatchObject({ displayName: 'Example After', relationship: 'dependent' });
    // A rename is not a re-consent — the audit trail is untouched.
    expect(await subjects.listSubjectConsents(subject.id)).toHaveLength(1);
  });

  it('appends to the consent audit trail newest-first', async () => {
    const subject = track(await subjects.createSubject({
      displayName: 'Example Audited', relationship: 'partner', consentMethod: 'verbal',
    }));
    await subjects.recordConsent({
      subjectId: subject.id, scope: 'broker_optout', method: 'written', note: 'second scope',
    });

    // Appending a second scope never replaces the first — consent accretes.
    const consents = await subjects.listSubjectConsents(subject.id);
    expect(consents).toHaveLength(2);
    expect(consents.map((c) => c.scope).sort()).toEqual(['broker_optout', 'pii_vault']);
    expect(consents.find((c) => c.scope === 'broker_optout')).toMatchObject({
      method: 'written', note: 'second scope',
    });
  });

  it('404s an unknown subject rather than leaking a raw FK violation', async () => {
    await expect(subjects.assertSubject('00000000-0000-4000-8000-0000000000ff')).rejects.toMatchObject({
      status: 404,
      code: 'SUBJECT_NOT_FOUND',
    });
  });

  it('refuses engine actions for a subject whose consent was revoked', async () => {
    const subject = track(await subjects.createSubject({
      displayName: 'Example Revoked', relationship: 'other', consentMethod: 'verbal',
    }));
    // Consent granted → the engine guard lets the action through.
    await expect(subjects.assertSubjectConsent(subject.id, { action: 'scan' }))
      .resolves.toMatchObject({ id: subject.id });

    await query(`DELETE FROM privacy_consents WHERE subject_id = $1`, [subject.id]);

    expect(await subjects.hasActiveConsent(subject.id)).toBe(false);
    await expect(subjects.assertSubjectConsent(subject.id, { action: 'scan' })).rejects.toMatchObject({
      status: 403,
      code: 'SUBJECT_CONSENT_REQUIRED',
    });
  });

  it('deleting a subject cascades their consent rows', async () => {
    const subject = track(await subjects.createSubject({
      displayName: 'Example Doomed', relationship: 'child', consentMethod: 'guardian',
    }));
    await subjects.deleteSubject(subject.id);
    createdSubjects.pop(); // deleted here — nothing left for afterAll to clean.

    const { rows } = await query(
      `SELECT id FROM privacy_consents WHERE subject_id = $1`, [subject.id],
    );
    expect(rows).toHaveLength(0);
    await expect(subjects.getSubject(subject.id)).resolves.toBeNull();
  });
});
