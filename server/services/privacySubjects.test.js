/**
 * Household-subject service unit tests (issue #3658) — DB mocked.
 *
 * Pins the three contracts other privacy services depend on:
 *   - `self` resolution: an absent subjectId is the seeded `self` row, so every
 *     pre-#3658 caller keeps its old behaviour.
 *   - subject creation writes the consent row in the SAME transaction, so a
 *     subject can never exist without recorded consent.
 *   - `assertSubjectConsent` REFUSES (403) a subject without an ACTIVE grant of
 *     the EXACT purpose scope — the engine-enforced half of the
 *     no-consent-no-action rule (#8332: a `pii_vault` grant never unlocks a
 *     broker purpose, and a revoked grant never counts).
 *   - `revokeConsent` withdraws one broker purpose by timestamping its grant
 *     rows — never by deleting them or the subject.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTransactionMock: vi.fn(),
}));

vi.mock('../lib/db.js', () => ({ query: queryMock, withTransaction: withTransactionMock }));

const {
  resolveSubjectId, createSubject, updateSubject, deleteSubject,
  listSubjects, assertSubject, hasActiveConsent, assertSubjectConsent, recordConsent,
  revokeConsent,
} = await import('./privacySubjects.js');
const { PRIVACY_SELF_SUBJECT_ID } = await import('../lib/privacyValidation.js');

const subjectRow = (overrides = {}) => ({
  id: PRIVACY_SELF_SUBJECT_ID, display_name: 'Me', relationship: 'self',
  created_at: 'now', updated_at: 'now', ...overrides,
});

beforeEach(() => {
  queryMock.mockReset();
  withTransactionMock.mockReset();
});

describe('resolveSubjectId', () => {
  it('falls back to the seeded `self` row for an absent or empty id', () => {
    expect(resolveSubjectId()).toBe(PRIVACY_SELF_SUBJECT_ID);
    expect(resolveSubjectId(undefined)).toBe(PRIVACY_SELF_SUBJECT_ID);
    expect(resolveSubjectId('')).toBe(PRIVACY_SELF_SUBJECT_ID);
  });

  it('passes an explicit id through untouched', () => {
    expect(resolveSubjectId('11111111-2222-4333-8444-555555555555')).toBe('11111111-2222-4333-8444-555555555555');
  });
});

describe('createSubject', () => {
  it('writes the subject AND its consent row inside ONE transaction', async () => {
    const client = { query: vi.fn(async (sql) => (/INSERT INTO privacy_subjects/.test(sql)
      ? { rows: [subjectRow({ id: 's2', display_name: 'Alex Example', relationship: 'partner' })] }
      : { rows: [] })) };
    withTransactionMock.mockImplementation(async (fn) => fn(client));

    const subject = await createSubject({
      displayName: 'Alex Example', relationship: 'partner', consentMethod: 'signed_form',
    });

    expect(withTransactionMock).toHaveBeenCalledTimes(1);
    const consentInsert = client.query.mock.calls.find(([sql]) => /INSERT INTO privacy_consents/.test(sql));
    expect(consentInsert).toBeDefined();
    expect(consentInsert[1][2]).toBe('signed_form'); // method
    expect(subject).toMatchObject({ id: 's2', relationship: 'partner', isSelf: false });
  });

  it('never logs the subject display name — it is PII, like the vault plaintext', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = { query: vi.fn(async (sql) => (/INSERT INTO privacy_subjects/.test(sql)
      ? { rows: [subjectRow({ id: 's2', display_name: 'Alex Example', relationship: 'partner' })] }
      : { rows: [] })) };
    withTransactionMock.mockImplementation(async (fn) => fn(client));
    await createSubject({ displayName: 'Alex Example', consentMethod: 'verbal' });
    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).not.toContain('Alex Example');
    logSpy.mockRestore();
  });
});

describe('assertSubject', () => {
  it('404s an unknown subject rather than letting a raw FK violation surface', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(assertSubject('11111111-2222-4333-8444-555555555555'))
      .rejects.toMatchObject({ status: 404, code: 'SUBJECT_NOT_FOUND' });
  });

  it('resolves an absent id to `self`', async () => {
    queryMock.mockResolvedValue({ rows: [subjectRow()] });
    const subject = await assertSubject();
    expect(queryMock.mock.calls[0][1]).toEqual([PRIVACY_SELF_SUBJECT_ID]);
    expect(subject.isSelf).toBe(true);
  });
});

describe('updateSubject', () => {
  it('builds a partial SET clause for only the provided fields', async () => {
    queryMock.mockResolvedValue({ rows: [subjectRow({ display_name: 'Renamed' })] });
    await updateSubject('s2', { displayName: 'Renamed' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/SET display_name = \$1, updated_at = NOW\(\)/);
    expect(params).toEqual(['Renamed', 's2']);
  });

  it('404s an unknown subject', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(updateSubject('s2', { displayName: 'x' }))
      .rejects.toMatchObject({ status: 404, code: 'SUBJECT_NOT_FOUND' });
  });
});

describe('deleteSubject', () => {
  it('refuses to delete `self` — every subject_id column defaults to it', async () => {
    await expect(deleteSubject(PRIVACY_SELF_SUBJECT_ID))
      .rejects.toMatchObject({ status: 400, code: 'SELF_SUBJECT_UNDELETABLE' });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('hard-deletes a household member (records cascade — no tombstone)', async () => {
    queryMock.mockResolvedValue({ rows: [{ id: 's2' }] });
    expect(await deleteSubject('s2')).toEqual({ ok: true });
    expect(queryMock.mock.calls[0][0]).toMatch(/DELETE FROM privacy_subjects/);
  });

  it('404s an unknown subject', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(deleteSubject('s2')).rejects.toMatchObject({ status: 404 });
  });
});

describe('listSubjects', () => {
  it('returns `self` first and carries consent/record counts for the UI switcher', async () => {
    queryMock.mockResolvedValue({
      rows: [
        { ...subjectRow(), consent_count: 1, record_count: 4, active_scopes: ['broker_scan', 'pii_vault'] },
        { ...subjectRow({ id: 's2', display_name: 'Alex Example', relationship: 'partner' }), consent_count: 0, record_count: 0, active_scopes: [] },
      ],
    });
    const subjects = await listSubjects();
    expect(subjects[0].isSelf).toBe(true);
    expect(subjects[0]).toMatchObject({ consentCount: 1, recordCount: 4, activeScopes: ['broker_scan', 'pii_vault'] });
    expect(subjects[1]).toMatchObject({ isSelf: false, consentCount: 0, activeScopes: [] });
    // Active purposes exclude revoked grants — what the scheduler selects on.
    expect(queryMock.mock.calls[0][0]).toMatch(/revoked_at IS NULL\) AS active_scopes/);
    // The ORDER BY must put `self` first regardless of display name.
    expect(queryMock.mock.calls[0][0]).toMatch(/ORDER BY \(s\.id <> \$1\)/);
  });
});

describe('recordConsent', () => {
  it('404s an unknown subject rather than emitting a raw FK violation', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(recordConsent({ subjectId: 's2', scope: 'pii_vault', method: 'written' }))
      .rejects.toMatchObject({ status: 404, code: 'SUBJECT_NOT_FOUND' });
  });

  it("defaults the NOT NULL scope column when the caller omits it", async () => {
    queryMock.mockImplementation(async (sql) => (/FROM privacy_subjects/.test(sql)
      ? { rows: [subjectRow({ id: 's2' })] }
      : { rows: [] }));
    const consent = await recordConsent({ subjectId: 's2', method: 'verbal' });
    const insert = queryMock.mock.calls.find(([q]) => /INSERT INTO privacy_consents/.test(q));
    expect(insert[1][2]).toBe('pii_vault');
    expect(consent.scope).toBe('pii_vault');
  });

  it('scopes the row by subject_id and stores the note verbatim', async () => {
    queryMock.mockImplementation(async (sql) => (/FROM privacy_subjects/.test(sql)
      ? { rows: [subjectRow({ id: 's2', relationship: 'partner' })] }
      : { rows: [] }));
    const consent = await recordConsent({
      subjectId: 's2', scope: 'broker_optout', method: 'written', note: 'form filed 2026-01-01',
    });
    const [sql, params] = queryMock.mock.calls.find(([q]) => /INSERT INTO privacy_consents/.test(q));
    expect(sql).toMatch(/INSERT INTO privacy_consents/);
    expect(params[1]).toBe('s2');
    expect(params[2]).toBe('broker_optout');
    expect(params[3]).toBe('written');
    expect(params[4]).toBe('form filed 2026-01-01');
    expect(consent).toMatchObject({ subjectId: 's2', scope: 'broker_optout', method: 'written' });
  });
});

describe('consent gate — purpose-scoped (#8332)', () => {
  // A fake consent table the mocked query() answers from, so the assertions
  // exercise the real SQL predicates' parameters rather than a canned boolean.
  const useConsentRows = (rows) => {
    queryMock.mockImplementation(async (sql, params) => {
      if (/FROM privacy_subjects/.test(sql)) return { rows: [subjectRow({ id: params[0], relationship: 'partner' })] };
      if (/SELECT 1 FROM privacy_consents/.test(sql)) {
        expect(sql).toMatch(/scope = \$2 AND revoked_at IS NULL/);
        const [subjectId, scope] = params;
        return { rows: rows.filter((r) => r.subjectId === subjectId && r.scope === scope && !r.revokedAt) };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
  };

  it('a pii_vault-only subject is refused BOTH broker purposes', async () => {
    useConsentRows([{ subjectId: 's2', scope: 'pii_vault' }]);
    expect(await hasActiveConsent('s2', 'pii_vault')).toBe(true);
    for (const scope of ['broker_scan', 'broker_optout']) {
      await expect(assertSubjectConsent('s2', { scope, action: 'x' }))
        .rejects.toMatchObject({ status: 403, code: 'SUBJECT_CONSENT_REQUIRED' });
    }
  });

  it('broker_scan unlocks the scan without unlocking submissions', async () => {
    useConsentRows([{ subjectId: 's2', scope: 'pii_vault' }, { subjectId: 's2', scope: 'broker_scan' }]);
    await expect(assertSubjectConsent('s2', { scope: 'broker_scan' })).resolves.toMatchObject({ id: 's2' });
    await expect(assertSubjectConsent('s2', { scope: 'broker_optout' }))
      .rejects.toMatchObject({ code: 'SUBJECT_CONSENT_REQUIRED' });
  });

  it('a revoked grant no longer counts', async () => {
    useConsentRows([{ subjectId: 's2', scope: 'broker_optout', revokedAt: '2026-01-02' }]);
    await expect(assertSubjectConsent('s2', { scope: 'broker_optout' }))
      .rejects.toMatchObject({ code: 'SUBJECT_CONSENT_REQUIRED' });
  });

  it('refuses to run an unscoped gate — there is no "any consent" mode', async () => {
    useConsentRows([{ subjectId: 's2', scope: 'pii_vault' }]);
    await expect(assertSubjectConsent('s2', { action: 'scan' })).rejects.toMatchObject({ code: 'CONSENT_SCOPE_INVALID' });
    await expect(hasActiveConsent('s2')).rejects.toMatchObject({ code: 'CONSENT_SCOPE_INVALID' });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('assertSubjectConsent 404s before it ever checks consent for an unknown subject', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(assertSubjectConsent('s2', { scope: 'broker_scan' })).rejects.toMatchObject({ status: 404, code: 'SUBJECT_NOT_FOUND' });
    expect(queryMock).toHaveBeenCalledTimes(1); // no consent probe
  });
});

describe('revokeConsent (#8332)', () => {
  it('timestamps the active grants of one scope and keeps the subject', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (/FROM privacy_subjects/.test(sql)) return { rows: [subjectRow({ id: 's2' })] };
      if (/UPDATE privacy_consents/.test(sql)) return { rows: [{ revoked_at: '2026-01-02T00:00:00Z' }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await revokeConsent({ subjectId: 's2', scope: 'broker_optout' });
    expect(result).toEqual({ subjectId: 's2', scope: 'broker_optout', revoked: 1, revokedAt: '2026-01-02T00:00:00Z' });
    const [sql, params] = queryMock.mock.calls.find(([q]) => /UPDATE privacy_consents/.test(q));
    expect(sql).toMatch(/SET revoked_at = NOW\(\)/);
    expect(sql).toMatch(/scope = \$2 AND revoked_at IS NULL/);
    expect(params).toEqual(['s2', 'broker_optout']);
    // Audit history and the subject survive: no DELETE of any kind.
    expect(queryMock.mock.calls.some(([q]) => /DELETE/.test(q))).toBe(false);
  });

  it('refuses to revoke local-vault consent (that still means deleting the subject)', async () => {
    await expect(revokeConsent({ subjectId: 's2', scope: 'pii_vault' }))
      .rejects.toMatchObject({ status: 400, code: 'CONSENT_SCOPE_NOT_REVOCABLE' });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('404s an unknown subject', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(revokeConsent({ subjectId: 's2', scope: 'broker_scan' }))
      .rejects.toMatchObject({ status: 404, code: 'SUBJECT_NOT_FOUND' });
  });
});
