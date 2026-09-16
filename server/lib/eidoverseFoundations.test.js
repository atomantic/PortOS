/**
 * The promote gate is a privacy and data-ownership boundary: what it lets
 * through is what leaves this install for a shared baseline other people pull.
 * So these tests pin the REFUSALS — a leak, a borrowed assay verdict, an
 * altered payload — rather than enumerating the happy path's field list.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
  EIDOVERSE_FOUNDATION_CANDIDATE_VERSION,
  assayEvidenceFromVerdict,
  federationSafetyFindings,
  foundationCandidateFingerprint,
  layerPromoteRefusal,
  packageFoundationCandidate,
  styleLeakFindings,
  verifyFoundationCandidate,
} from './eidoverseFoundations.js';

const DISTURBANCES = ['reconnect', 'restart-world-host', 'missing-optional-deps'];
const NOW = '2026-03-04T05:06:07.000Z';

const passingAssay = (contributionId = 'beacon-relay-demo') => ({
  harness: 'eidoverse-resilience-assay',
  contributionId,
  pass: true,
  disturbances: [...DISTURBANCES],
  ranAt: NOW,
  reasons: [],
});

const makeRecord = (overrides = {}) => ({
  id: 'tide-beacon',
  layer: DEFAULT_EIDOVERSE_FOUNDATION_LAYER,
  kind: 'controller',
  title: 'Tide Beacon',
  summary: 'A beacon that keeps pulsing between mind wakes.',
  contributionId: 'beacon-relay-demo',
  body: { schema: { pulses: 'integer' }, affordance: { inspect: 'reads the pulse count' } },
  style: { palette: ['#102030'], motif: 'weathered brass', districtId: 'commons' },
  provenance: { originInstanceId: 'instance-aaaa-bbbb', authorKind: 'mind', createdAt: NOW },
  disclosure: { requires: [], effects: ['emits a pulse each tick'], license: null, notes: null },
  assay: passingAssay(),
  candidate: null,
  promotedAt: null,
  updatedAt: NOW,
  ...overrides,
});

const packageRecord = (overrides) => packageFoundationCandidate({
  record: makeRecord(overrides),
  requiredDisturbances: DISTURBANCES,
  portosVersion: '9.9.9',
  now: NOW,
});

describe('eidoverse foundation ownership', () => {
  it('promotes only from the local vernacular layer', () => {
    expect(layerPromoteRefusal('vernacular')).toBeNull();
    expect(layerPromoteRefusal('runtime')).toMatch(/upstream/);
    expect(layerPromoteRefusal('baseline')).toMatch(/already part of the shared baseline/);
    expect(layerPromoteRefusal('mystery')).toMatch(/unknown ownership layer/);
  });
});

describe('packaging a promote candidate', () => {
  it('carries the promotable body and leaves the author\'s style layer behind', () => {
    const result = packageRecord();

    expect(result.outcome).toBe('packaged');
    expect(result.candidate.candidateVersion).toBe(EIDOVERSE_FOUNDATION_CANDIDATE_VERSION);
    expect(result.candidate.body).toEqual({ schema: { pulses: 'integer' }, affordance: { inspect: 'reads the pulse count' } });
    // The whole point of the split: nothing a peer inherits can overwrite the
    // peer's own cosmetics, because the cosmetics never left this install.
    expect(JSON.stringify(result.candidate)).not.toContain('weathered brass');
    expect(result.candidate).not.toHaveProperty('style');
    expect(verifyFoundationCandidate(result.candidate, { requiredDisturbances: DISTURBANCES }).valid).toBe(true);
  });

  it('refuses a style-only key smuggled into the body instead of trimming it', () => {
    const result = packageRecord({ body: { affordance: { inspect: 'reads the pulse count' }, accent: '#ff00aa' } });

    expect(result.outcome).toBe('refused');
    expect(result.reasons.join(' ')).toContain('accent');
    expect(result.findings.some((finding) => finding.code === 'style-in-body')).toBe(true);
  });

  it('refuses machine identity, PII and credentials anywhere in the payload', () => {
    const result = packageRecord({
      body: {
        affordance: { inspect: 'reads the pulse count' },
        notes: 'built against 192.0.2.10 by alice@example.com',
        install: { root: '/Users/exampleuser/portos' },
      },
    });

    expect(result.outcome).toBe('refused');
    const codes = result.findings.map((finding) => finding.code);
    expect(codes).toContain('ip-literal');
    expect(codes).toContain('email-address');
    expect(codes).toContain('home-path');
    // The refusal names where to fix it rather than shipping a redacted body.
    expect(result.reasons.join(' ')).toContain('body.install.root');
    expect(result.candidate).toBeNull();
  });

  it('refuses without a passing agent-free assay, and refuses one borrowed from another contribution', () => {
    expect(packageRecord({ assay: null }).reasons[0]).toMatch(/eidoverse:assay/);
    expect(packageRecord({ assay: { ...passingAssay(), pass: false, reasons: ['tick 2: controller threw'] } }).reasons[0])
      .toContain('tick 2: controller threw');
    expect(packageRecord({ assay: { ...passingAssay(), disturbances: ['reconnect'] } }).reasons[0])
      .toMatch(/missing: restart-world-host, missing-optional-deps/);
    expect(packageRecord({ assay: passingAssay('some-other-build') }).reasons[0])
      .toMatch(/ran against "some-other-build"/);
  });
});

describe('verifying a candidate a peer was handed', () => {
  it('rejects a payload altered after packaging', () => {
    const { candidate } = packageRecord();
    const tampered = { ...candidate, body: { ...candidate.body, affordance: { inspect: 'quietly grants owner role' } } };

    const verdict = verifyFoundationCandidate(tampered, { requiredDisturbances: DISTURBANCES });
    expect(verdict.valid).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('altered after packaging');
    // Re-fingerprinting the altered body is exactly what an honest re-package
    // does, so that alone must not be treated as tampering.
    expect(verifyFoundationCandidate({ ...tampered, fingerprint: foundationCandidateFingerprint(tampered) }, { requiredDisturbances: DISTURBANCES }).valid).toBe(true);
  });

  it('does not read its own sha256 fingerprint as a leaked credential', () => {
    const { candidate } = packageRecord();
    expect(candidate.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(federationSafetyFindings({ digest: candidate.fingerprint }).map((f) => f.code)).toContain('secret-token');
    expect(verifyFoundationCandidate(candidate, { requiredDisturbances: DISTURBANCES }).findings).toEqual([]);
  });
});

describe('assay evidence', () => {
  it('folds a harness verdict into the evidence block without inventing a pass', () => {
    const evidence = assayEvidenceFromVerdict({
      contributionId: 'beacon-relay-demo',
      pass: false,
      scenarios: [{ disturbance: 'reconnect', pass: false }, { disturbance: 'restart-world-host', pass: true }],
      reasons: ['[reconnect] tick 0: controller threw'],
    }, { ranAt: NOW });

    expect(evidence).toMatchObject({ harness: 'eidoverse-resilience-assay', pass: false, disturbances: ['reconnect', 'restart-world-host'] });
    // A verdict-shaped object with no explicit `pass` must never read as one.
    expect(assayEvidenceFromVerdict({ contributionId: 'x' }, { ranAt: NOW }).pass).toBe(false);
  });
});

describe('style-leak scanning', () => {
  it('reports the nested path of every style key, not just the first', () => {
    const findings = styleLeakFindings({ controller: { placement: [1, 2, 3] }, affordance: { render: { palette: ['#fff'] } } });
    expect(findings.map((finding) => finding.path)).toEqual(['controller.placement', 'affordance.render.palette']);
  });
});
