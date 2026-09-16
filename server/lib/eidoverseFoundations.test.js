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
  foundationCandidateFingerprint,
  foundationFromInheritedCandidate,
  foundationLineage,
  inheritedFoundationStorageKey,
  layerPromoteRefusal,
  packageFoundationCandidate,
  styleLeakFindings,
  verifyFoundationCandidate,
} from './eidoverseFoundations.js';
import { federationSafetyFindings } from './federationSafety.js';

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

  it('refuses to re-promote an inherited foundation as though this install authored it', () => {
    const result = packageRecord({
      layer: 'baseline',
      inheritance: {
        type: 'inherited-from', originInstanceId: 'instance-peer-origin', foundationId: 'tide-beacon',
        fingerprint: 'a'.repeat(64), packagedAt: NOW, sourceInstanceId: 'instance-peer-origin', inheritedAt: NOW,
      },
    });

    expect(result.outcome).toBe('refused');
    expect(result.reasons.join(' ')).toContain('inherited from another install');
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

  it('does not read schema normalization as tampering', () => {
    // The digest covers the bytes as sent. Hashing the zod-normalized copy
    // instead would make a field that arrived padded — which the envelope
    // schema trims — verify as an altered payload.
    const { candidate } = packageRecord();
    const padded = { ...candidate, provenance: { ...candidate.provenance, portosVersion: ' 9.9.9 ' } };
    const sent = { ...padded, fingerprint: foundationCandidateFingerprint(padded) };

    expect(verifyFoundationCandidate(sent, { requiredDisturbances: DISTURBANCES }).valid).toBe(true);
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
    const findings = styleLeakFindings({ controller: { motif: 'brass' }, affordance: { render: { palette: ['#fff'] } } });
    expect(findings.map((finding) => finding.path)).toEqual(['controller.motif', 'affordance.render.palette']);
  });
});

describe('inheriting a foundation from a peer (#7461)', () => {
  const LOCAL_INSTANCE_ID = 'instance-local-0001';
  const SOURCE_INSTANCE_ID = 'instance-peer-relay';

  it('builds a baseline local copy with an inherited-from edge, style dropped, own authorship never claimed', () => {
    const { candidate } = packageRecord();

    const result = foundationFromInheritedCandidate({
      candidate, requiredDisturbances: DISTURBANCES, sourceInstanceId: SOURCE_INSTANCE_ID, localInstanceId: LOCAL_INSTANCE_ID, now: NOW,
    });

    expect(result.outcome).toBe('inherited');
    expect(result.foundation).toMatchObject({
      id: 'tide-beacon',
      layer: 'baseline',
      style: {},
      promotedAt: null,
      provenance: { originInstanceId: 'instance-aaaa-bbbb', authorKind: 'mind' },
      inheritance: {
        type: 'inherited-from',
        originInstanceId: 'instance-aaaa-bbbb',
        foundationId: 'tide-beacon',
        fingerprint: candidate.fingerprint,
        sourceInstanceId: SOURCE_INSTANCE_ID,
        inheritedAt: NOW,
      },
    });
  });

  it('refuses a self-referential pull instead of recording a loop', () => {
    const { candidate } = packageRecord();

    const result = foundationFromInheritedCandidate({
      candidate, requiredDisturbances: DISTURBANCES, sourceInstanceId: SOURCE_INSTANCE_ID, localInstanceId: 'instance-aaaa-bbbb', now: NOW,
    });

    expect(result.outcome).toBe('refused');
    expect(result.foundation).toBeNull();
    expect(result.reasons.join(' ')).toContain('originated on this install');
  });

  it('refuses a candidate altered after packaging, exactly as a peer running verifyFoundationCandidate would', () => {
    const { candidate } = packageRecord();
    const tampered = { ...candidate, body: { ...candidate.body, affordance: { inspect: 'quietly grants owner role' } } };

    const result = foundationFromInheritedCandidate({
      candidate: tampered, requiredDisturbances: DISTURBANCES, sourceInstanceId: SOURCE_INSTANCE_ID, localInstanceId: LOCAL_INSTANCE_ID, now: NOW,
    });

    expect(result.outcome).toBe('refused');
    expect(result.foundation).toBeNull();
    expect(result.reasons.join(' ')).toContain('altered after packaging');
  });

  it('refuses PII/machine-identity smuggled into the body even when the fingerprint is internally consistent', () => {
    // Bypass probe: `packageFoundationCandidate` would never emit this
    // envelope (packaging itself refuses the leak), so hand-build the shape
    // an untrusted or buggy peer might send — self-fingerprinted so schema
    // AND digest both pass — to prove the RECEIVING side's privacy scan
    // catches it independently of whether the sender's own gate did.
    const draft = {
      candidateVersion: EIDOVERSE_FOUNDATION_CANDIDATE_VERSION,
      foundationId: 'tide-beacon',
      kind: 'controller',
      title: 'Tide Beacon',
      summary: 'A beacon that keeps pulsing between mind wakes.',
      contributionId: 'beacon-relay-demo',
      body: { affordance: { inspect: 'reads the pulse count' }, notes: 'built against 192.0.2.10 by alice@example.com' },
      disclosure: { requires: [], effects: [], license: null, notes: null },
      provenance: { originInstanceId: 'instance-aaaa-bbbb', authorKind: 'mind', createdAt: NOW, packagedAt: NOW, portosVersion: '9.9.9' },
      assay: passingAssay(),
    };
    const forged = { ...draft, fingerprint: foundationCandidateFingerprint(draft) };
    expect(verifyFoundationCandidate(forged, { requiredDisturbances: DISTURBANCES }).valid).toBe(false); // sanity: a peer would refuse it too

    const result = foundationFromInheritedCandidate({
      candidate: forged, requiredDisturbances: DISTURBANCES, sourceInstanceId: SOURCE_INSTANCE_ID, localInstanceId: LOCAL_INSTANCE_ID, now: NOW,
    });

    expect(result.outcome).toBe('refused');
    expect(result.foundation).toBeNull();
    expect(result.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(['ip-literal', 'email-address']));
  });

  it('refuses when this install has no federation identity yet to check a pull against', () => {
    const { candidate } = packageRecord();
    const result = foundationFromInheritedCandidate({
      candidate, requiredDisturbances: DISTURBANCES, sourceInstanceId: SOURCE_INSTANCE_ID, localInstanceId: '', now: NOW,
    });
    expect(result.outcome).toBe('refused');
    expect(result.foundation).toBeNull();
  });
});

describe('inherited foundation storage key', () => {
  it('can never collide with an id a local author could write, so an inherited copy never shadows local vernacular work', () => {
    const key = inheritedFoundationStorageKey('instance-aaaa-bbbb', 'tide-beacon');
    expect(key).toBe('peer:instance-aaaa-bbbb:tide-beacon');
    // A local id is a lowercase slug with no colon — this key can never equal one.
    expect(key).not.toMatch(/^[a-z0-9][a-z0-9-]*$/);
  });
});

describe('foundation lineage (#7461)', () => {
  it('projects authored, assayed, packaged, and promoted in chronological order from fields the record already carries', () => {
    const { candidate } = packageRecord();
    const packagedLater = { ...candidate, provenance: { ...candidate.provenance, packagedAt: '2026-03-04T06:00:00.000Z' } };
    const record = { ...makeRecord(), candidate: packagedLater, promotedAt: '2026-03-04T08:00:00.000Z' };

    expect(foundationLineage(record).map((event) => event.type)).toEqual(['authored', 'assayed', 'packaged', 'promoted']);
  });

  it('collapses to inherited + assayed for a local copy of a peer foundation, never restating packaged or promoted', () => {
    const { candidate } = packageRecord();
    const { foundation } = foundationFromInheritedCandidate({
      candidate, requiredDisturbances: DISTURBANCES, sourceInstanceId: 'instance-peer-relay', localInstanceId: 'instance-local-0001', now: NOW,
    });

    expect(foundationLineage(foundation).map((event) => event.type)).toEqual(['inherited', 'assayed']);
  });

  it('returns an empty lineage for a missing record rather than throwing', () => {
    expect(foundationLineage(null)).toEqual([]);
    expect(foundationLineage(undefined)).toEqual([]);
  });
});
