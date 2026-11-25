/**
 * Pure-logic tests for the broker case state machine + recheck backoff +
 * refresh parsers (issue #2144), plus the subject-scoped case-list query shape
 * (#3658). The DB is mocked (the pure tests don't touch it); the real DB
 * round-trip lives in privacyBrokers.db.test.js.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, withTransactionMock } = vi.hoisted(() => ({ queryMock: vi.fn(), withTransactionMock: vi.fn() }));
vi.mock('../lib/db.js', () => ({ query: queryMock, withTransaction: withTransactionMock }));

const { eraseMock } = vi.hoisted(() => ({ eraseMock: vi.fn(async () => ({})) }));
vi.mock('./messageDrafts.js', () => ({ erasePrivacyDrafts: eraseMock, scrubLegacyPrivacyDraftValues: vi.fn() }));

const SELF = '00000000-0000-4000-8000-000000000001';
vi.mock('./privacySubjects.js', () => ({ resolveSubjectId: (id) => id || SELF }));

const {
  CASE_STATES,
  SCAN_VERDICTS,
  assertTransition,
  allowedTransitionsFor,
  computeNextRecheckAt,
  parseCaRegistryCsv,
  parseBadboolList,
  getBroker,
  refreshBrokers,
  listBrokerCases,
  recordScanVerdict,
  ensureSeeded,
  resetEnsureSeededForTests,
  clearCaseIdentityEvidence,
  transitionCase,
  clearSubjectIdentityEvidence,
  revealCaseEvidence,
  __resetCaseEvidenceSealForTests,
} = await import('./privacyBrokers.js');

beforeEach(() => queryMock.mockReset());

describe('ensureSeeded — syncing curated brokers on boot/upgrade (#4019)', () => {
  it('calls seedCuratedBrokers on initial ensureSeeded invocation', async () => {
    resetEnsureSeededForTests();
    await expect(ensureSeeded()).resolves.not.toThrow();
  });
});

describe('listBrokerCases — subject scoping (#3658)', () => {
  it('always scopes to a subject and binds the state filter as $2 (not a literal)', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await listBrokerCases({ state: 'found' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE c\.subject_id = \$1 AND c\.state = \$2/);
    expect(params).toEqual([SELF, 'found']);
  });

  it('scopes to an explicit subject with no state filter', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await listBrokerCases({ subjectId: 'subject-2' });
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toMatch(/WHERE c\.subject_id = \$1\s/);
    expect(params).toEqual(['subject-2']);
  });
});

describe('assertTransition — valid paths', () => {
  it('allows every scan verdict from unscanned', () => {
    for (const to of SCAN_VERDICTS) {
      expect(() => assertTransition('unscanned', to)).not.toThrow();
    }
  });

  it('walks the opt-out lifecycle forward', () => {
    const chain = [
      ['found', 'optout_in_progress'],
      ['optout_in_progress', 'submitted'],
      ['submitted', 'verification_pending'],
      ['verification_pending', 'awaiting_processing'],
    ];
    for (const [from, to] of chain) expect(() => assertTransition(from, to)).not.toThrow();
  });

  it('allows any state → human_task_queued', () => {
    for (const from of CASE_STATES) {
      if (from === 'human_task_queued') continue;
      expect(() => assertTransition(from, 'human_task_queued')).not.toThrow();
    }
  });

  it('allows idempotent same-state re-stamp', () => {
    expect(() => assertTransition('submitted', 'submitted')).not.toThrow();
  });
});

describe('assertTransition — confirmed_removed is rescan-only', () => {
  it('rejects confirmed_removed without viaRescan even from awaiting_processing', () => {
    expect(() => assertTransition('awaiting_processing', 'confirmed_removed'))
      .toThrowError(/only reachable from a verifying re-scan/i);
  });

  it('accepts confirmed_removed from awaiting_processing WITH viaRescan', () => {
    expect(() => assertTransition('awaiting_processing', 'confirmed_removed', { viaRescan: true })).not.toThrow();
  });

  it('rejects confirmed_removed from a submission state even with viaRescan', () => {
    // A submission page can never confirm removal — only verification_pending /
    // awaiting_processing / human_task_queued may.
    expect(() => assertTransition('submitted', 'confirmed_removed', { viaRescan: true }))
      .toThrowError(/invalid transition/i);
  });

  it('rejects a bare submitted → confirmed_removed (the classic hole)', () => {
    let code;
    try { assertTransition('submitted', 'confirmed_removed'); } catch (e) { code = e.code; }
    expect(code).toBe('CONFIRMED_REQUIRES_RESCAN');
  });
});

describe('assertTransition — reappeared is confirmed_removed + rescan only', () => {
  it('accepts confirmed_removed → reappeared via rescan', () => {
    expect(() => assertTransition('confirmed_removed', 'reappeared', { viaRescan: true })).not.toThrow();
  });
  it('rejects reappeared from any other state', () => {
    expect(() => assertTransition('found', 'reappeared', { viaRescan: true })).toThrow();
  });
  it('rejects reappeared without rescan', () => {
    expect(() => assertTransition('confirmed_removed', 'reappeared')).toThrow();
  });
});

describe('assertTransition — invalid transitions rejected', () => {
  it('rejects skipping the lifecycle (found → submitted)', () => {
    expect(() => assertTransition('found', 'submitted')).toThrowError(/invalid transition/i);
  });
  it('rejects an unknown target state', () => {
    let code;
    try { assertTransition('unscanned', 'banana'); } catch (e) { code = e.code; }
    expect(code).toBe('INVALID_CASE_STATE');
  });
  it('rejects an unknown source state', () => {
    expect(() => assertTransition('bogus', 'found')).toThrowError(/unknown case state/i);
  });
});

describe('allowedTransitionsFor — client action gating (issue #2417)', () => {
  it('never returns a target assertTransition would reject as a manual move', () => {
    // The list is the authority the UI filters against, so every entry MUST be a
    // legal non-rescan transition from that state.
    for (const from of CASE_STATES) {
      for (const to of allowedTransitionsFor(from)) {
        expect(() => assertTransition(from, to)).not.toThrow();
      }
    }
  });

  it('excludes the rescan-only targets (confirmed_removed, reappeared)', () => {
    for (const from of CASE_STATES) {
      const allowed = allowedTransitionsFor(from);
      expect(allowed).not.toContain('confirmed_removed');
      expect(allowed).not.toContain('reappeared');
    }
  });

  it('offers human_task_queued from every OTHER state, never itself', () => {
    for (const from of CASE_STATES) {
      const allowed = allowedTransitionsFor(from);
      expect(allowed).not.toContain(from); // no idempotent self
      if (from !== 'human_task_queued') expect(allowed).toContain('human_task_queued');
    }
  });

  it('gives blocked its legal positive move (found) but NOT submitted (the classic hole)', () => {
    const allowed = allowedTransitionsFor('blocked');
    expect(allowed).toContain('found');
    expect(allowed).toContain('not_found');
    expect(allowed).not.toContain('submitted');
  });

  it('lets a queued human task be marked submitted or dismissed to not_found', () => {
    const allowed = allowedTransitionsFor('human_task_queued');
    expect(allowed).toContain('submitted');
    expect(allowed).toContain('not_found');
  });

  it('lets awaiting_processing transition to found and human_task_queued (#4020)', () => {
    const allowed = allowedTransitionsFor('awaiting_processing');
    expect(allowed).toContain('found');
    expect(allowed).toContain('human_task_queued');
  });

  it('returns only the any-state target for an unknown state', () => {
    expect(allowedTransitionsFor('bogus')).toEqual(['human_task_queued']);
  });
});

describe('computeNextRecheckAt — state-dependent backoff', () => {
  const now = new Date('2026-07-08T00:00:00.000Z');
  const days = (state) => (new Date(computeNextRecheckAt(state, now)) - now) / (24 * 60 * 60 * 1000);

  it('uses the documented backoffs', () => {
    expect(days('submitted')).toBe(3);
    expect(days('awaiting_processing')).toBe(7);
    expect(days('confirmed_removed')).toBe(30);
    expect(days('not_found')).toBe(60);
  });
  it('rechecks unscanned immediately (0 days)', () => {
    expect(days('unscanned')).toBe(0);
  });
  it('falls back to 14 days for an unmapped state', () => {
    expect(days('weird')).toBe(14);
  });
});

describe('parseCaRegistryCsv', () => {
  it('extracts name + url rows', () => {
    const csv = 'Business Name,Website URL\nAcme Data,https://acme.example\n"Beta,\nInc.",https://beta.example';
    const out = parseCaRegistryCsv(csv);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ name: 'Acme Data', source: 'ca_registry', confidence: 'auto' });
    expect(out[0].id).toBe('ca-acme-data');
    expect(out[0].urls).toEqual({ home: 'https://acme.example' });
    expect(out[1]).toMatchObject({ name: 'Beta,\nInc.', urls: { home: 'https://beta.example' } });
  });
  it('keeps only an HTTP(S) home link from the website column', () => {
    const csv = 'Business Name,Opt-Out URL,Website URL,Search URL\n'
      + 'Acme,https://optout.example,http://acme.example,https://search.example\n'
      + 'Beta,https://optout.example,javascript:example,https://search.example';
    expect(parseCaRegistryCsv(csv).map(({ urls, optout }) => ({ urls, optout }))).toEqual([
      { urls: { home: 'http://acme.example' }, optout: {} },
      { urls: {}, optout: {} },
    ]);
  });
  it('returns [] on empty / headerless input', () => {
    expect(parseCaRegistryCsv('')).toEqual([]);
    expect(parseCaRegistryCsv('just one line')).toEqual([]);
  });
});

describe('parseBadboolList', () => {
  it('normalizes a JSON array of broker entries', () => {
    const out = parseBadboolList([{ name: 'Foo Search', url: 'https://foo.example' }, { id: 'bar', name: 'Bar' }]);
    expect(out.length).toBe(2);
    expect(out[0]).toMatchObject({ id: 'foo-search', name: 'Foo Search', source: 'badbool', confidence: 'auto' });
    expect(out[1].id).toBe('bar');
  });
  it('accepts a { brokers: [...] } wrapper and drops nameless rows', () => {
    const out = parseBadboolList({ brokers: [null, { url: 'https://x.example' }, { name: 'Yes' }] });
    expect(out.map((b) => b.name)).toEqual(['Yes']);
  });
  it('ignores search and opt-out fields and validates both home link shapes', () => {
    const out = parseBadboolList([
      { name: 'Nested', urls: { home: 'https://nested.example', search: 'https://search.example' }, optout: { method: 'email' } },
      { name: 'Unsafe', urls: { home: 'file:///example' } },
      { name: 'Unsafe flat', url: 'data:text/plain,example' },
    ]);
    expect(out.map(({ urls, optout }) => ({ urls, optout }))).toEqual([
      { urls: { home: 'https://nested.example' }, optout: {} },
      { urls: {}, optout: {} },
      { urls: {}, optout: {} },
    ]);
  });
});

describe('broker discovery storage boundary', () => {
  it('writes only validated home links from refreshed brokers', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    withTransactionMock.mockImplementation(async (fn) => fn(client));
    await refreshBrokers({
      fetchBadbool: async () => [{ id: 'auto', urls: { home: 'https://auto.example', search: 'https://search.example' }, optout: { method: 'email' } }],
      fetchCaRegistry: async () => [{ id: 'ca-auto', urls: { home: 'file:///example' }, optout: { method: 'web_form' } }],
    });
    const inserted = client.query.mock.calls.filter(([sql, params]) => /INSERT INTO privacy_brokers/.test(sql) && ['auto', 'ca-auto'].includes(params[0]));
    expect(inserted.map(([, [id, , urls, optout]]) => [id, JSON.parse(urls), JSON.parse(optout)])).toEqual([
      ['auto', { home: 'https://auto.example' }, {}],
      ['ca-auto', {}, {}],
    ]);
  });

  it('filters legacy discovery automation on read and preserves curated automation', async () => {
    const urls = { home: 'https://broker.example', search: 'https://broker.example/search' };
    const optout = { method: 'web_form', url: 'https://broker.example/optout' };
    queryMock.mockResolvedValueOnce({ rows: [{ source: 'badbool', urls, optout }] });
    queryMock.mockResolvedValueOnce({ rows: [{ source: 'ca_registry', urls: { home: 'file:///example' }, optout }] });
    queryMock.mockResolvedValueOnce({ rows: [{ source: 'curated', urls, optout }] });
    const badbool = await getBroker('badbool');
    expect(badbool.urls).toEqual({ home: urls.home });
    expect(badbool.optout).toEqual({});
    const ca = await getBroker('ca');
    expect(ca.urls).toEqual({});
    expect(ca.optout).toEqual({});
    const curated = await getBroker('curated');
    expect(curated.urls).toEqual(urls);
    expect(curated.optout).toEqual(optout);
  });
});

describe('recordScanVerdict — 23505 unique constraint fallback (#4021)', () => {
  it('handles unique constraint violation 23505 during concurrent insert and falls back to update branch', async () => {
    const clientMock = {
      query: vi.fn(),
    };
    withTransactionMock.mockImplementation(async (fn) => fn(clientMock));

    // 1. SELECT broker -> found
    clientMock.query.mockResolvedValueOnce({ rows: [{ id: 'spokeo' }] });
    // 2. SELECT existing case -> none found initially
    clientMock.query.mockResolvedValueOnce({ rows: [] });
    // 3. SAVEPOINT -> ok
    clientMock.query.mockResolvedValueOnce({});
    // 4. INSERT -> throws Postgres error 23505
    const err23505 = new Error('duplicate key value violates unique constraint "idx_privacy_broker_cases_broker_subject"');
    err23505.code = '23505';
    clientMock.query.mockRejectedValueOnce(err23505);
    // 5. ROLLBACK TO SAVEPOINT -> ok
    clientMock.query.mockResolvedValueOnce({});
    // 6. Re-SELECT existing case FOR UPDATE -> now found (inserted by concurrent call)
    clientMock.query.mockResolvedValueOnce({ rows: [{ id: 'case-123', state: 'unscanned' }] });
    // 7. UPDATE case -> success
    const mockCaseRow = {
      id: 'case-123',
      subject_id: SELF,
      broker_id: 'spokeo',
      state: 'found',
      found: true,
      evidence: '{}',
      disclosed_fields: [],
      channel: null,
      reason: null,
      next_recheck_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    clientMock.query.mockResolvedValueOnce({ rows: [mockCaseRow] });

    const result = await recordScanVerdict('spokeo', 'found');
    expect(result).toBeDefined();
    expect(result.id).toBe('case-123');
    expect(result.state).toBe('found');
  });
});

describe('case erasure removes the linked opt-out draft (#17233)', () => {
  const caseRow = (state, evidence) => ({ id: 'case-1', subject_id: SELF, broker_id: 'spokeo', state, found: false, evidence, disclosed_fields: [] });
  const expectCaseScoped = () => {
    const [predicate, opts] = eraseMock.mock.calls[0];
    expect(opts).toEqual({ generatedBy: ['privacy-optout'] });
    expect(predicate({ id: 'draft-9' })).toBe(true);
    expect(predicate({ id: 'other', privacyMeta: { caseId: 'case-1' } })).toBe(true);
    expect(predicate({ id: 'other', privacyMeta: { caseId: 'case-2' } })).toBe(false);
  };

  it('clearCaseIdentityEvidence erases the case draft referenced by evidence.draftId', async () => {
    eraseMock.mockClear();
    queryMock.mockResolvedValueOnce({ rows: [caseRow('submitted', { lane: 'email', draftId: 'draft-9' })] });
    await clearCaseIdentityEvidence('case-1');
    expectCaseScoped();
  });

  it('transitionCase to confirmed_removed erases the case draft; other transitions do not', async () => {
    eraseMock.mockClear();
    const client = { query: vi.fn(async (sql) => (/SELECT id, state, evidence/.test(sql)
      ? { rows: [{ id: 'case-1', state: 'awaiting_processing', evidence: { lane: 'email', draftId: 'draft-9' } }] }
      : { rows: [caseRow('confirmed_removed', { lane: 'email', draftId: 'draft-9' })] })) };
    withTransactionMock.mockImplementation(async (fn) => fn(client));
    await transitionCase('case-1', 'confirmed_removed', { viaRescan: true });
    expectCaseScoped();

    eraseMock.mockClear();
    client.query.mockImplementation(async (sql) => (/SELECT id, state, evidence/.test(sql)
      ? { rows: [{ id: 'case-1', state: 'found', evidence: {} }] }
      : { rows: [caseRow('optout_in_progress', {})] }));
    await transitionCase('case-1', 'optout_in_progress');
    expect(eraseMock).not.toHaveBeenCalled();
  });
});

describe('broker confirmation link is sealed identity evidence (#17758)', () => {
  const URL_ = 'https://broker.example.com/confirm?token=abc&email=a%40example.com';
  const row = (state, evidence) => ({ id: 'case-1', subject_id: SELF, broker_id: 'spokeo', state, found: true, evidence, disclosed_fields: [] });
  const writtenEvidence = (client) => {
    const call = client.query.mock.calls.find(([sql]) => /^UPDATE privacy_broker_cases SET/.test(sql));
    const raw = call[1].find((p) => typeof p === 'string' && p.includes('{'));
    return JSON.parse(raw);
  };
  const transitionWith = async (stored, evidence) => {
    const client = { query: vi.fn(async (sql) => (/SELECT id, state, evidence/.test(sql)
      ? { rows: [{ id: 'case-1', state: 'submitted', evidence: stored }] }
      : { rows: [row('verification_pending', {})] })) };
    withTransactionMock.mockImplementation(async (fn) => fn(client));
    await transitionCase('case-1', 'verification_pending', { evidence });
    return writtenEvidence(client);
  };

  it('seals verification_url and merges it with the existing envelope instead of dropping matched/search/listing fields', async () => {
    const first = await transitionWith({}, { matched_name: 'Jane Example', search_url: 'https://b.example.com/s', listing_urls: ['https://b.example.com/l/1'] });
    const second = await transitionWith(first, { verification: { messageId: 'm1', score: 3 }, verification_url: URL_ });
    expect(second.verification).toEqual({ messageId: 'm1', score: 3 });
    expect(JSON.stringify(second)).not.toContain('token=abc');
    expect(second.sealed_identity.listing_count).toBe(1);

    // Reveal opens the merged envelope: the link sits beside the older fields.
    queryMock.mockResolvedValue({ rows: [{ id: 'case-1', evidence: second }] });
    const revealed = await revealCaseEvidence('case-1');
    expect(revealed.evidence).toEqual({
      matched_name: 'Jane Example', search_url: 'https://b.example.com/s', listing_urls: ['https://b.example.com/l/1'], verification_url: URL_,
    });
  });

  it('seals a legacy plaintext evidence.verification.url written inline', async () => {
    const stored = await transitionWith({}, { verification: { messageId: 'm1', score: 3, url: URL_ } });
    expect(stored.verification).toEqual({ messageId: 'm1', score: 3 });
    expect(JSON.stringify(stored)).not.toContain('token=abc');
  });

  it('the case projection never returns the plaintext link even from an unconverted legacy row', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValueOnce({ rows: [row('verification_pending', { verification: { messageId: 'm1', score: 3, url: URL_ } })] });
    const c = await clearCaseIdentityEvidence('case-1');
    expect(JSON.stringify(c)).not.toContain('token=abc');
  });

  it('legacy migration selects rows holding a plaintext verification url and seals them', async () => {
    __resetCaseEvidenceSealForTests();
    const legacy = { verification: { messageId: 'm1', score: 3, url: URL_ } };
    const client = { query: vi.fn(async (sql) => (/^SELECT id, evidence/.test(sql) ? { rows: [{ id: 'case-1', evidence: legacy }] } : { rows: [] })) };
    withTransactionMock.mockImplementation(async (fn) => fn(client));
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [{ id: 'case-1', evidence: {} }] });
    await revealCaseEvidence('case-1');
    const [selectSql] = client.query.mock.calls[0];
    expect(selectSql).toMatch(/evidence->'verification' \? 'url'/);
    const stored = writtenEvidence(client);
    expect(stored.verification).toEqual({ messageId: 'm1', score: 3 });
    expect(stored.sealed_identity).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain('token=abc');
  });

  it('explicit erase and subject erase strip both the envelope and any legacy verification.url', async () => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [row('found', {})], rowCount: 1 });
    await clearCaseIdentityEvidence('case-1');
    await clearSubjectIdentityEvidence('subject-2');
    for (const [sql, params] of queryMock.mock.calls.filter(([s]) => /^\s*UPDATE/.test(s))) {
      expect(sql).toContain("#- '{verification,url}'");
      expect(params[0]).toEqual(expect.arrayContaining(['sealed_identity', 'verification_url']));
    }
    expect(queryMock.mock.calls.find(([s]) => /WHERE subject_id/.test(s))[0]).toMatch(/evidence->'verification' \? 'url'/);
  });
});
