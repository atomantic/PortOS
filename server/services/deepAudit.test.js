import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: [], query: vi.fn(), ensureSchema: vi.fn(async () => {}) }));
vi.mock('../lib/db.js', () => ({ query: db.query, ensureSchema: db.ensureSchema }));

const { deepAuditProgress } = await import('../lib/deepAudit.js');
const { getDeepAuditLedger } = await import('./deepAudit.js');

const receipt = status => ({ status });
const ledger = (units, extra = {}) => ({ delivery: 'file-issues', scope: { files: [] }, candidates: {}, units, groups: [], reason: 'Awaiting evidence', ...extra });
const fullEvidence = status => ({ static: receipt(status), trace: receipt(status), adversarial: receipt(status), challenge: receipt(status) });

describe('historical Deep ledger reads', () => {
  it('returns the stored ledger, or null for an unknown id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ ledger: { id: 'old' } }] }).mockResolvedValueOnce({ rows: [] });
    expect(await getDeepAuditLedger('old')).toEqual({ id: 'old' });
    expect(await getDeepAuditLedger('missing')).toBeNull();
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('deep_audit_ledgers'), ['old']);
  });

  it('summarizes a partially covered ledger as resumable with blockers and pending candidates counted', () => {
    const progress = deepAuditProgress(ledger([
      { id: 'a', evidence: { static: receipt('evidenced'), trace: receipt('evidenced') } },
      { id: 'b', evidence: { static: receipt('blocked') } },
      { id: 'c', evidence: fullEvidence('evidenced') },
    ], { candidates: { x: { disposition: 'pending' }, y: { disposition: 'rejected' } } }));
    expect(progress).toMatchObject({ discoveryComplete: false, complete: false, resume: true, totalUnits: 3, reviewedUnits: 1,
      satisfiedPasses: 6, requiredPasses: 12, blockedUnits: 1, pendingCandidates: 1 });
    expect(progress.statuses).toMatchObject({ traced: 1, blocked: 1, reviewed: 1 });
  });

  it('reports discovery and file-issues delivery complete only with all passes, verified delivery and no pending candidates', () => {
    const base = ledger([{ id: 'a', evidence: fullEvidence('evidenced') }, { id: 'b', evidence: fullEvidence('inapplicable') }],
      { deliveryVerified: true, groups: [{ id: 'g', unitIds: ['a', 'b'] }] });
    expect(deepAuditProgress(base)).toMatchObject({ discoveryComplete: true, deliveryComplete: true, complete: true, resume: false,
      reviewedUnits: 2, reviewedGroups: 1 });
    expect(deepAuditProgress({ ...base, deliveryVerified: false })).toMatchObject({ discoveryComplete: true, complete: false, resume: true });
    expect(deepAuditProgress({ ...base, invalidReason: 'Source changed' })).toMatchObject({ discoveryComplete: false, reason: 'Source changed' });
  });

  it('requires a revision-matched post-fix pass and resolved remediation for fix delivery', () => {
    const post = { 'post-fix': { status: 'evidenced', validationRevision: 'r1' } };
    const units = [{ id: 'a', evidence: { ...fullEvidence('evidenced'), ...post } }];
    const fix = ledger(units, { delivery: 'fix', deliveryVerified: true, validationRevision: 'r1',
      candidates: { c: { disposition: 'resolved', resolvedRevision: 'r0' } } });
    expect(deepAuditProgress(fix)).toMatchObject({ deliveryComplete: true, remediationComplete: false, pendingRemediations: 1, complete: false });
    fix.candidates.c.resolvedRevision = 'r1';
    expect(deepAuditProgress(fix)).toMatchObject({ remediationComplete: true, complete: true });
  });
});
