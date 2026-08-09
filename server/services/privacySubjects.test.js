/**
 * Household-subject service unit tests (issue #3658) — DB mocked.
 *
 * Pins the three contracts other privacy services depend on:
 *   - `self` resolution: an absent subjectId is the seeded `self` row, so every
 *     pre-#3658 caller keeps its old behaviour.
 *   - subject creation writes the consent row in the SAME transaction, so a
 *     subject can never exist without recorded consent.
 *   - `assertSubjectConsent` REFUSES (403) a subject with no consent row — the
 *     engine-enforced half of the no-consent-no-action rule.
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
        { ...subjectRow(), consent_count: 1, record_count: 4 },
        { ...subjectRow({ id: 's2', display_name: 'Alex Example', relationship: 'partner' }), consent_count: 0, record_count: 0 },
      ],
    });
    const subjects = await listSubjects();
    expect(subjects[0].isSelf).toBe(true);
    expect(subjects[0]).toMatchObject({ consentCount: 1, recordCount: 4 });
    expect(subjects[1]).toMatchObject({ isSelf: false, consentCount: 0 });
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

describe('consent gate', () => {
  it('hasActiveConsent is true when ANY consent row exists for the subject', async () => {
    queryMock.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    expect(await hasActiveConsent('s2')).toBe(true);
    expect(queryMock.mock.calls[0][1]).toEqual(['s2']);
  });

  it('hasActiveConsent is false when the subject has no rows', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    expect(await hasActiveConsent('s2')).toBe(false);
  });

  it('assertSubjectConsent REFUSES a consentless subject with a 403', async () => {
    queryMock.mockImplementation(async (sql) => (/FROM privacy_subjects/.test(sql)
      ? { rows: [subjectRow({ id: 's2', relationship: 'partner' })] }
      : { rows: [] }));
    await expect(assertSubjectConsent('s2', { action: 'broker opt-out pass' }))
      .rejects.toMatchObject({ status: 403, code: 'SUBJECT_CONSENT_REQUIRED' });
  });

  it('assertSubjectConsent returns the subject when consent is on file', async () => {
    queryMock.mockImplementation(async (sql) => (/FROM privacy_subjects/.test(sql)
      ? { rows: [subjectRow({ id: 's2', relationship: 'partner' })] }
      : { rows: [{ '?column?': 1 }] }));
    await expect(assertSubjectConsent('s2')).resolves.toMatchObject({ id: 's2' });
  });

  it('assertSubjectConsent 404s before it ever checks consent for an unknown subject', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(assertSubjectConsent('s2')).rejects.toMatchObject({ status: 404, code: 'SUBJECT_NOT_FOUND' });
    expect(queryMock).toHaveBeenCalledTimes(1); // no consent probe
  });
});
