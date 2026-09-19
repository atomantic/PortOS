/**
 * Guard: the Eidoverse foundation promote envelope must NEVER carry `style`,
 * the local ledger's local-only keys, or unbounded assay/disclosure prose.
 *
 * This is the positive-authorization mirror of `privacyNeverFederates.test.js`,
 * `beeperNeverFederates.test.js` and `providerGraphNeverFederates.test.js` — ADR
 * `docs/decisions/2026-09-18-federated-eidoverse-foundations.md` authorizes
 * exactly the promote envelope, enumerated field by field, to cross the
 * federation layer. If you are here because this test failed, the answer is
 * almost certainly "don't widen the envelope without a matching ADR change and
 * `EIDOVERSE_FOUNDATION_CANDIDATE_VERSION` bump" — read that ADR's
 * "Revisiting" section first.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
  derivedContributionId,
  eidoverseFoundationCandidateSchema,
  packageFoundationCandidate,
  styleLeakFindings,
} from '../../lib/eidoverseFoundations.js';

const DISTURBANCES = ['reconnect', 'restart-world-host', 'missing-optional-deps'];
const NOW = '2026-03-04T05:06:07.000Z';
const BODY = { schema: { pulses: 'integer' }, affordance: { inspect: 'reads the pulse count' } };

// The binding label is DERIVED from the record's own kind/body (#7625), never
// chosen — so the fixture derives it too rather than naming one packaging would
// refuse as evidence about some other contribution.
const CONTRIBUTION_ID = derivedContributionId({ kind: 'controller', id: 'tide-lantern', body: BODY });

const passingAssay = (contributionId = CONTRIBUTION_ID) => ({
  harness: 'eidoverse-resilience-assay',
  contributionId,
  pass: true,
  disturbances: [...DISTURBANCES],
  ranAt: NOW,
  reasons: [],
});

// Everything a real local ledger record carries — including the fields the
// ADR says stay machine-local — so the assertions below prove those fields
// were DROPPED by packaging rather than merely absent from this fixture.
const makeRecord = (overrides = {}) => ({
  id: 'tide-lantern',
  layer: DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
  kind: 'controller',
  title: 'Tide Lantern',
  summary: 'A lantern that keeps pulsing between mind wakes.',
  contributionId: CONTRIBUTION_ID,
  body: BODY,
  style: { palette: ['#102030'], motif: 'weathered brass', districtId: 'commons', accent: '#ffaa00' },
  provenance: { originInstanceId: 'instance-example-0001', authorKind: 'mind', createdAt: NOW },
  disclosure: { requires: [], effects: ['emits a pulse each tick'], license: null, notes: null },
  assay: passingAssay(),
  candidate: null,
  promotedAt: null,
  inheritance: null,
  updatedAt: NOW,
  ...overrides,
});

const packageRecord = (overrides) => packageFoundationCandidate({
  record: makeRecord(overrides),
  requiredDisturbances: DISTURBANCES,
  portosVersion: '9.9.9',
  now: NOW,
});

// Ledger-only keys that must never appear on a built envelope. `style` is the
// headline case the issue names; the rest are the local ledger's own
// bookkeeping (ownership layer, promotion timestamp, provenance edge, and the
// stored-verbatim candidate the record keeps for itself).
const LEDGER_ONLY_KEYS = ['style', 'layer', 'promotedAt', 'inheritance', 'candidate'];

describe('eidoverse foundation promote envelope never carries style or ledger-only fields (ADR 2026-09-18, #7635)', () => {
  it('drops style and every other ledger-only key when packaging a candidate', () => {
    const { outcome, candidate } = packageRecord();
    expect(outcome).toBe('packaged');
    for (const key of LEDGER_ONLY_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(candidate, key)).toBe(false);
    }
  });

  it('declares no `style` field on the wire schema itself', () => {
    expect(Object.keys(eidoverseFoundationCandidateSchema.shape)).not.toContain('style');
    for (const key of LEDGER_ONLY_KEYS) {
      expect(Object.keys(eidoverseFoundationCandidateSchema.shape)).not.toContain(key);
    }
  });

  it('refuses (does not silently strip) a style-shaped key smuggled inside body', () => {
    const findings = styleLeakFindings({ palette: ['#102030'] });
    expect(findings).toEqual([
      expect.objectContaining({ code: 'style-in-body' }),
    ]);
    const { outcome, findings: packageFindings } = packageRecord({
      body: { schema: { pulses: 'integer' }, palette: ['#102030'] },
    });
    expect(outcome).toBe('refused');
    expect(packageFindings.some((f) => f.code === 'style-in-body')).toBe(true);
  });

  it('carries only an opaque instance id and coarse authorKind — never a display name', () => {
    const { candidate } = packageRecord();
    expect(Object.keys(candidate.provenance).sort()).toEqual(
      ['authorKind', 'createdAt', 'originInstanceId', 'packagedAt', 'portosVersion'].sort(),
    );
    expect(['mind', 'cos', 'user']).toContain(candidate.provenance.authorKind);
    expect(candidate.provenance.originInstanceId).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('caps assay evidence to the fixed verdict shape — no free-form transcript', () => {
    const { candidate } = packageRecord();
    expect(Object.keys(candidate.assay).sort()).toEqual(
      ['contributionId', 'disturbances', 'harness', 'pass', 'ranAt', 'reasons'].sort(),
    );
  });

  it('carries no property outside the envelope schema on a packaged candidate', () => {
    const { candidate } = packageRecord();
    const parsed = eidoverseFoundationCandidateSchema.safeParse(candidate);
    expect(parsed.success).toBe(true);
  });
});
